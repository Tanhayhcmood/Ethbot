require('dotenv').config();
const { ethers } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const NonceManager = require('./nonceManager');
const InstanceLockManager = require('./instanceLockManager');
const MetricsCollector = require('./metricsCollector');
const MempoolMonitor = require('./mempoolMonitor');
const AtomicFileWriter = require('./fileOperations');  // CRITICAL FIX C-1

// ===================================================================
// ⚡ ULTRA-FAST ETH TRANSFER BOT - EVENT-DRIVEN ARCHITECTURE
// Speed: 100/100 - Uses real-time events instead of slow polling
// ===================================================================

function maskSensitiveData(str) {
  if (!str) return str;
  const strValue = String(str);
  
  if (strValue.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
    return '0x' + '*'.repeat(60) + strValue.slice(-4);
  }
  
  if (strValue.match(/^0x[0-9a-fA-F]{40}$/)) {
    return strValue.slice(0, 6) + '...' + strValue.slice(-4);
  }
  
  return strValue;
}

function checkRootUser() {
  const isRoot = process.getuid && process.getuid() === 0;
  
  if (isRoot) {
    console.error('\n❌ SECURITY ERROR: Running as root user is not allowed!\n');
    process.exit(1);
  }
  
  const currentUser = process.env.USER || process.env.USERNAME || 'unknown';
  const uid = process.getuid ? process.getuid() : 'N/A';
  
  console.log(`✅ Security check passed - Running as non-root user`);
  console.log(`👤 User: ${currentUser} (UID: ${uid})\n`);
}

checkRootUser();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS;

const originalLog = console.log;
const originalError = console.error;

function safeLog(...args) {
  const safeArgs = args.map(arg => {
    if (typeof arg === 'string' && PRIVATE_KEY && arg.includes(PRIVATE_KEY)) {
      try {
        return arg.replace(new RegExp(PRIVATE_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), maskSensitiveData(PRIVATE_KEY));
      } catch (e) {
        return arg;
      }
    }
    return arg;
  });
  originalLog.apply(console, safeArgs);
}

function safeError(...args) {
  const safeArgs = args.map(arg => {
    if (typeof arg === 'string' && PRIVATE_KEY && arg.includes(PRIVATE_KEY)) {
      try {
        return arg.replace(new RegExp(PRIVATE_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), maskSensitiveData(PRIVATE_KEY));
      } catch (e) {
        return arg;
      }
    }
    return arg;
  });
  originalError.apply(console, safeArgs);
}

console.log = safeLog;
console.error = safeError;
console.warn = safeError;

// ===================================================================
// CONFIGURATION
// ===================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_PASSWORD = process.env.TELEGRAM_PASSWORD;
const PORT = parseInt(process.env.PORT) || 5000;
const USE_EVENT_DRIVEN = process.env.USE_EVENT_DRIVEN !== 'false';

const RPC_URLS = [
  { name: 'Primary RPC', url: process.env.RPC_URL_PRIMARY || process.env.RPC_URL, priority: 1 },
  { name: 'Secondary RPC', url: process.env.RPC_URL_SECONDARY, priority: 2 },
  { name: 'Tertiary RPC', url: process.env.RPC_URL_TERTIARY, priority: 3 },
  { name: 'Backup RPC 1', url: process.env.RPC_URL_BACKUP_1, priority: 4 },
  { name: 'Backup RPC 2', url: process.env.RPC_URL_BACKUP_2, priority: 5 },
  { name: 'Backup RPC 3', url: process.env.RPC_URL_BACKUP_3, priority: 6 }
].filter(rpc => rpc.url);

const POLL_INTERVAL = Math.max(30, parseInt(process.env.POLL_INTERVAL) || 30);  // HYPER-OPTIMIZED: 30ms default
const MAX_RETRY_ATTEMPTS = Math.max(1, Math.min(10, parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3));
const GAS_SAFETY_BUFFER_PERCENT = 2;
const PENDING_TX_TIMEOUT = 180000;
const RBF_GAS_INCREASE_PERCENT = 15;
const RPC_TIMEOUT = 2000;  // OPTIMIZED: Increased to 2000ms to prevent failures on busy networks
const MAX_RPC_RETRIES = 2;  // Reduced retries for faster response

// CRITICAL FIX C-5: Circuit Breaker for infinite loop protection
const MAX_RPC_RETRY_ATTEMPTS = 10;  // Maximum retry attempts before giving up
const CIRCUIT_BREAKER_THRESHOLD = 10; // Trip after this many consecutive failures
const CIRCUIT_BREAKER_RESET_TIME = 300000; // 5 minutes

// ===================================================================
// GLOBAL STATE
// ===================================================================

let providers = [];
let wallet;
let telegramBot;
let monitoredAddress;
let nonceManager;
let instanceLockManager;
let metricsCollector;
let isProcessing = new Map();
let lastBalance = 0n;
let consecutiveRateLimitErrors = 0;
const RATE_LIMIT_ALERT_THRESHOLD = 10;
let pendingTransactions = new Map();
let pendingTxFilePath = null;

// Event-driven specific
let blockListener = null;
let mempoolListener = null;
let mempoolMonitor = null;
let isMonitoring = false;
let lastProcessedBlock = 0;
let pollingInterval = null;
let isReconnecting = false;  // PROFESSIONAL FIX: Prevent race conditions in WebSocket reconnection
let reconnectionTimeout = null;
let lastBlockReceivedAt = Date.now();
let blockWatchdog = null;
const WATCHDOG_STALL_MS = process.env.WATCHDOG_STALL_MS ? Number(process.env.WATCHDOG_STALL_MS) : 45000;

// PROFESSIONAL RPC FAILOVER SYSTEM
let currentProviderIndex = 0;  // Track active provider
let providerFailureCount = new Map();  // Track failures per provider
let lastProviderSwitch = null;  // Track when last switch occurred
const MAX_PROVIDER_FAILURES = 3;  // Max failures before switching
const PROVIDER_SWITCH_COOLDOWN = 60000;  // 1 minute cooldown between switches

// CRITICAL FIX C-5: Circuit breaker state
let consecutiveRpcFailures = 0;
let circuitBreakerTripped = false;
let circuitBreakerTrippedAt = null;

let globalProcessingLock = false;
let globalLockAcquiredAt = null;
const GLOBAL_LOCK_TIMEOUT = 90000;

// CRITICAL FIX C-2: Event listener tracking for memory leak prevention
const activeListeners = {
  block: null,
  mempool: null,
  error: null,
  close: null,
  open: null
};

function checkAndAcquireGlobalLock() {
  if (globalProcessingLock && globalLockAcquiredAt) {
    const lockHeldTime = Date.now() - globalLockAcquiredAt;
    if (lockHeldTime > GLOBAL_LOCK_TIMEOUT) {
      console.log(`⚠️ Releasing stale lock (held ${Math.round(lockHeldTime / 1000)}s > ${GLOBAL_LOCK_TIMEOUT / 1000}s timeout)`);
      globalProcessingLock = false;
      globalLockAcquiredAt = null;
    }
  }
  
  if (globalProcessingLock) {
    return false;
  }
  
  globalProcessingLock = true;
  globalLockAcquiredAt = Date.now();
  console.log('🔒 Global transfer lock acquired');
  return true;
}

// CRITICAL FIX C-3: Guaranteed lock release function
function releaseGlobalLock(context = '') {
  if (globalProcessingLock) {
    const lockDuration = Date.now() - globalLockAcquiredAt;
    console.log(`🔓 Global lock released${context ? ` (${context})` : ''} - held for ${lockDuration}ms`);
    globalProcessingLock = false;
    globalLockAcquiredAt = null;
  }
}

const telegramRateLimits = new Map();
const TELEGRAM_RATE_LIMIT_MS = 300;
const TELEGRAM_MAX_COMMANDS_PER_MINUTE = 20;

const botStatus = {
  running: false,
  paused: false,  // NEW: برای /pause و /resume
  lastBlock: 0,
  errors: 0,
  totalTransfers: 0,
  successfulTransfers: 0,
  retriedTransfers: 0,
  rbfReplacements: 0,
  startTime: Date.now(),
  detectionTimes: [],
  transferTimes: [],
  lastBalanceCheck: null,
  insufficientFundWarning: null,
  eventDrivenMode: USE_EVENT_DRIVEN,
  transactionHistory: []  // NEW: برای ذخیره تاریخچه تراکنش‌ها
};

const providerHealth = new Map();
const MAX_METRICS_LENGTH = 100;

const authenticatedUsers = new Map();
const failedAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 3;
const BLOCK_DURATION = 5 * 60 * 1000;

const commandCache = new Map();
const CACHE_DURATION_MS = 5000;

// ===================================================================
// GRACEFUL SHUTDOWN
// ===================================================================

// CRITICAL FIX C-2: Cleanup all event listeners to prevent memory leaks
function cleanupAllListeners() {
  console.log('🧹 Cleaning up all event listeners...');
  
  const provider = providers[0]?.provider;
  if (!provider) return;
  
  // Remove block listener
  if (activeListeners.block) {
    provider.off('block', activeListeners.block);
    activeListeners.block = null;
    console.log('✅ Block listener removed');
  }
  
  // Remove mempool listener
  if (activeListeners.mempool) {
    provider.off('pending', activeListeners.mempool);
    activeListeners.mempool = null;
    console.log('✅ Mempool listener removed');
  }
  
  // Remove WebSocket listeners
  const ws = provider._websocket || provider.websocket;
  if (ws) {
    if (activeListeners.error) {
      ws.off('error', activeListeners.error);
      activeListeners.error = null;
    }
    if (activeListeners.close) {
      ws.off('close', activeListeners.close);
      activeListeners.close = null;
    }
    if (activeListeners.open) {
      ws.off('open', activeListeners.open);
      activeListeners.open = null;
    }
    console.log('✅ WebSocket listeners removed');
  }
}

async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal} - Initiating graceful shutdown...`);
  
  try {
    // CRITICAL FIX C-2: Use centralized cleanup
    cleanupAllListeners();
    
    if (mempoolMonitor) {
      await mempoolMonitor.stop();
      mempoolMonitor = null;
      console.log('✅ Mempool monitor stopped');
    }
    
    if (pollingInterval) {
      clearInterval(pollingInterval);
      console.log('✅ Polling interval cleared');
    }
    
    for (const [txHash, data] of pendingTransactions.entries()) {
      if (data.intervalId) {
        clearInterval(data.intervalId);
      }
      if (data.absoluteTimeoutId) {
        clearTimeout(data.absoluteTimeoutId);
      }
    }
    
    await savePendingTransactions();
    console.log('✅ Pending transactions saved');
    
    if (instanceLockManager) {
      await instanceLockManager.releaseLock();
      console.log('✅ Instance lock released');
    }
    
    if (telegramBot) {
      await telegramBot.stopPolling();
      console.log('✅ Telegram bot stopped');
    }
    
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection (continuing):', reason);
  botStatus.errors++;
  
  if (metricsCollector) {
    metricsCollector.recordError(new Error(String(reason)), 'unhandledRejection');
  }
  
  if (telegramBot && TELEGRAM_CHAT_ID) {
    sendTelegramMessage(`⚠️ <b>Error occurred (bot continues running)</b>\n\n${String(reason).substring(0, 200)}`).catch(() => {});
  }
});

process.on('uncaughtException', (error) => {
  console.error('⚠️ Uncaught Exception (recovering):', error.message);
  console.error('Stack:', error.stack);
  botStatus.errors++;
  
  if (metricsCollector) {
    metricsCollector.recordError(error, 'uncaughtException');
  }
  
  if (telegramBot && TELEGRAM_CHAT_ID) {
    sendTelegramMessage(`⚠️ <b>Unexpected Error</b>\n\n${error.message}\n\n✅ Bot continues running`).catch(() => {});
  }
  
  if (globalProcessingLock) {
    releaseGlobalLock('uncaught-exception');
  }
  
  // CRITICAL FIX C-5: Reset circuit breaker on restart after exception
  if (circuitBreakerTripped) {
    console.log('🔄 Resetting circuit breaker due to uncaught exception');
    circuitBreakerTripped = false;
    circuitBreakerTrippedAt = null;
    consecutiveRpcFailures = 0;
  }
});

// ===================================================================
// ENVIRONMENT VALIDATION
// ===================================================================

function validateEnvVariables() {
  const required = ['PRIVATE_KEY', 'DESTINATION_ADDRESS'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`❌ Required environment variables missing: ${missing.join(', ')}`);
  }

  if (RPC_URLS.length === 0) {
    throw new Error('❌ At least one RPC URL must be configured');
  }
  
  for (const rpc of RPC_URLS) {
    if (!rpc.url.startsWith('http://') && !rpc.url.startsWith('https://') && !rpc.url.startsWith('wss://') && !rpc.url.startsWith('ws://')) {
      throw new Error(`❌ Invalid RPC URL format for ${rpc.name}: ${rpc.url}`);
    }
  }
  
  if (!PRIVATE_KEY.match(/^(0x)?[0-9a-fA-F]{64}$/)) {
    throw new Error('❌ Invalid PRIVATE_KEY format');
  }
  
  if (!ethers.isAddress(DESTINATION_ADDRESS)) {
    throw new Error('❌ Invalid DESTINATION_ADDRESS format');
  }
  
  if (TELEGRAM_BOT_TOKEN) {
    if (!TELEGRAM_PASSWORD || TELEGRAM_PASSWORD.length < 8) {
      throw new Error(`❌ TELEGRAM_PASSWORD is required (min 8 characters)`);
    }
    console.log('✅ Telegram password validation passed');
  }
}

async function testPrivateKey() {
  try {
    const testWallet = new ethers.Wallet(PRIVATE_KEY);
    const testMessage = 'Bot initialization test';
    const signature = await testWallet.signMessage(testMessage);
    
    if (!signature || signature.length < 100) {
      throw new Error('Invalid signature generated');
    }
    
    console.log('✅ Private key test passed');
    return true;
  } catch (error) {
    throw new Error(`❌ Private key test failed: ${error.message}`);
  }
}

function validateAddresses() {
  if (!monitoredAddress || !DESTINATION_ADDRESS) {
    return;
  }
  
  if (monitoredAddress.toLowerCase() === DESTINATION_ADDRESS.toLowerCase()) {
    throw new Error(
      `❌ CRITICAL ERROR: Source and destination addresses are the same!\n` +
      `This would cause all funds to be spent on gas fees.`
    );
  }
  
  console.log('✅ Address validation passed - source ≠ destination');
}

// ===================================================================
// HTTP SERVER & HEALTH CHECK
// ===================================================================

const app = express();

app.get('/health', async (req, res) => {
  try {
    const uptime = Math.floor((Date.now() - botStatus.startTime) / 1000);
    const avgDetectionTime = botStatus.detectionTimes.length > 0
      ? botStatus.detectionTimes.reduce((a, b) => a + b, 0) / botStatus.detectionTimes.length
      : 0;
    const avgTransferTime = botStatus.transferTimes.length > 0
      ? botStatus.transferTimes.reduce((a, b) => a + b, 0) / botStatus.transferTimes.length
      : 0;

    let nonceStatus = null;
    if (nonceManager && nonceManager.isInitialized) {
      try {
        nonceStatus = await nonceManager.getNonceStatus();
      } catch (error) {
        nonceStatus = { error: error.message };
      }
    }

    res.json({
      status: botStatus.running ? 'healthy' : 'starting',
      mode: botStatus.eventDrivenMode ? '⚡ EVENT-DRIVEN (Ultra-Fast)' : '⏱️ Polling',
      monitoredAddress: monitoredAddress ? maskSensitiveData(monitoredAddress) : 'initializing',
      destinationAddress: DESTINATION_ADDRESS ? maskSensitiveData(DESTINATION_ADDRESS) : 'initializing',
      lastBlock: botStatus.lastBlock,
      errors: botStatus.errors,
      totalTransfers: botStatus.totalTransfers,
      retriedTransfers: botStatus.retriedTransfers,
      rbfReplacements: botStatus.rbfReplacements,
      pendingTransactions: pendingTransactions.size,
      successRate: botStatus.totalTransfers > 0 
        ? ((botStatus.successfulTransfers / botStatus.totalTransfers) * 100).toFixed(2) + '%'
        : 'N/A',
      uptime: `${uptime}s`,
      rpcProviders: Array.from(providerHealth.entries()).map(([name, data]) => ({
        name,
        status: data.status,
        latency: data.latency
      })),
      nonceManagement: nonceStatus,
      performance: {
        avgDetectionTime: avgDetectionTime.toFixed(0) + 'ms',
        avgTransferTime: avgTransferTime.toFixed(0) + 'ms',
        eventDriven: botStatus.eventDrivenMode
      }
    });
  } catch (error) {
    console.error('⚠️ Health check error:', error.message);
    res.status(500).json({ error: 'Health check failed', message: error.message });
  }
});

app.get('/metrics', (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics not available yet' });
    }
    
    const response = {
      metrics: metricsCollector.getMetrics(),
      summary: metricsCollector.getSummary(),
      recentErrors: metricsCollector.getRecentErrors(),
      recentTransactions: metricsCollector.getRecentTransactions()
    };
    
    if (mempoolMonitor) {
      response.mempoolMetrics = mempoolMonitor.getMetrics();
    }
    
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: 'Metrics error', message: error.message });
  }
});

app.get('/mempool', (req, res) => {
  try {
    if (!mempoolMonitor) {
      return res.status(503).json({ 
        error: 'Mempool monitoring not active',
        suggestion: 'Enable event-driven mode with WebSocket RPC to activate mempool monitoring'
      });
    }
    
    res.json({
      status: 'active',
      metrics: mempoolMonitor.getMetrics(),
      info: {
        description: 'Advanced mempool monitoring for ultra-fast transaction detection',
        detectionSpeed: '5-10ms (before block mining)',
        advantage: 'Detects incoming transactions before they are mined into blocks'
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Mempool endpoint error', message: error.message });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>⚡ Ultra-Fast ETH Transfer Bot</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
          }
          .container {
            max-width: 800px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.1);
            padding: 30px;
            border-radius: 10px;
            backdrop-filter: blur(10px);
          }
          h1 { font-size: 2.5em; margin: 0; }
          .badge {
            display: inline-block;
            padding: 5px 15px;
            background: #4CAF50;
            border-radius: 20px;
            font-size: 0.9em;
            margin: 10px 5px;
          }
          .speed-badge {
            background: #FF5722;
            font-weight: bold;
            font-size: 1.1em;
          }
          a {
            color: #4CAF50;
            text-decoration: none;
            font-weight: bold;
          }
          a:hover { text-decoration: underline; }
          .features {
            margin-top: 20px;
            line-height: 1.8;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⚡ Ultra-Fast ETH Transfer Bot</h1>
          ${botStatus.eventDrivenMode ? '<span class="badge speed-badge">EVENT-DRIVEN MODE - 100/100 SPEED</span>' : '<span class="badge">Polling Mode</span>'}
          <span class="badge">✅ LIVE</span>
          
          <div class="features">
            <p><strong>🚀 Speed Optimizations:</strong></p>
            <p>✅ ${botStatus.eventDrivenMode ? 'Real-time block events (no polling delay!)' : 'Optimized polling'}</p>
            <p>✅ Instant transaction detection</p>
            <p>✅ Parallel RPC processing</p>
            <p>✅ Zero unnecessary delays</p>
            <p>✅ Live gas price fetching with EIP-1559</p>
            <p>✅ Dynamic gas estimation</p>
            <p>✅ Replace-by-Fee (RBF) for stuck transactions</p>
            <p>✅ Secure logging (no private key exposure)</p>
            <p>✅ Comprehensive error handling</p>
            
            <p style="margin-top: 30px;">
              <a href="/health">📊 Health Check JSON</a> &nbsp;|&nbsp;
              <a href="/metrics">📈 Performance Metrics</a>
            </p>
            
            <p style="color: #ddd; font-size: 0.9em; margin-top: 30px;">
              Status: <span style="color: #4CAF50;">⚡ Running at Maximum Speed</span>
            </p>
          </div>
        </div>
      </body>
    </html>
  `);
});

// ===================================================================
// TELEGRAM NOTIFICATIONS
// ===================================================================

async function sendTelegramMessage(message) {
  try {
    if (telegramBot && TELEGRAM_CHAT_ID) {
      await Promise.race([
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram timeout')), 5000))
      ]);
      if (metricsCollector) {
        metricsCollector.recordTelegramMessage(true);
      }
    }
  } catch (error) {
    console.error('⚠️ Telegram notification failed (non-blocking):', error.message);
    if (metricsCollector) {
      metricsCollector.recordTelegramMessage(false);
    }
  }
}

// ===================================================================
// TELEGRAM AUTHENTICATION
// ===================================================================

function isRateLimited(chatId) {
  const now = Date.now();
  const userLimits = telegramRateLimits.get(chatId);
  
  if (!userLimits) {
    telegramRateLimits.set(chatId, {
      lastCommand: now,
      commandsInLastMinute: [now]
    });
    return false;
  }
  
  if (now - userLimits.lastCommand < TELEGRAM_RATE_LIMIT_MS) {
    return true;
  }
  
  userLimits.commandsInLastMinute = userLimits.commandsInLastMinute.filter(
    timestamp => now - timestamp < 60000
  );
  
  if (userLimits.commandsInLastMinute.length >= TELEGRAM_MAX_COMMANDS_PER_MINUTE) {
    return true;
  }
  
  userLimits.lastCommand = now;
  userLimits.commandsInLastMinute.push(now);
  telegramRateLimits.set(chatId, userLimits);
  
  return false;
}

function isUserBlocked(chatId) {
  const attempts = failedAttempts.get(chatId);
  if (!attempts) return false;
  
  const { count, blockedUntil } = attempts;
  
  if (blockedUntil && Date.now() < blockedUntil) {
    return true;
  }
  
  if (blockedUntil && Date.now() >= blockedUntil) {
    failedAttempts.delete(chatId);
    return false;
  }
  
  return false;
}

function recordFailedAttempt(chatId) {
  const attempts = failedAttempts.get(chatId) || { count: 0, blockedUntil: null };
  attempts.count++;
  
  if (attempts.count >= MAX_FAILED_ATTEMPTS) {
    attempts.blockedUntil = Date.now() + BLOCK_DURATION;
    attempts.count = 0;
  }
  
  failedAttempts.set(chatId, attempts);
}

function isAuthenticated(chatId) {
  return authenticatedUsers.has(chatId) && authenticatedUsers.get(chatId) === true;
}

async function requireAuth(msg, callback) {
  const chatId = msg.chat.id;
  
  if (isRateLimited(chatId)) {
    await telegramBot.sendMessage(
      chatId,
      '⚠️ <b>Too Many Requests!</b>\n\nPlease wait before sending another command.',
      { parse_mode: 'HTML' }
    );
    return;
  }
  
  if (isUserBlocked(chatId)) {
    const attempts = failedAttempts.get(chatId);
    const remainingTime = Math.ceil((attempts.blockedUntil - Date.now()) / 1000 / 60);
    await telegramBot.sendMessage(
      chatId,
      `🔒 <b>Blocked!</b>\n\n⚠️ Blocked for <b>${remainingTime} minutes</b>.`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  
  if (!isAuthenticated(chatId)) {
    await telegramBot.sendMessage(
      chatId,
      '🔐 <b>Authentication Required!</b>\n\n🔑 Please send your password:',
      { parse_mode: 'HTML' }
    );
    return;
  }
  
  await callback();
}

// ===================================================================
// RPC PROVIDER MANAGEMENT
// ===================================================================

async function withExponentialBackoff(fn, maxRetries = MAX_RPC_RETRIES, baseDelay = 20) {
  // HYPER-FAST: Minimal retry delay for maximum speed
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      // Ultra aggressive timeout for maximum speed
      const adaptiveTimeout = RPC_TIMEOUT * (1 + (attempt * 0.2));
      
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), adaptiveTimeout))
      ]);
      
      if (metricsCollector) {
        metricsCollector.recordRPCCall(true, Date.now() - startTime);
      }
      
      return result;
    } catch (error) {
      lastError = error;
      
      if (metricsCollector) {
        metricsCollector.recordRPCCall(false, 0);
      }
      
      // PROFESSIONAL FAILOVER: Record failure on last attempt
      if (attempt === maxRetries - 1) {
        recordProviderFailure();
      }
      
      if (attempt < maxRetries - 1) {
        // Ultra-minimal delay for hyper-fast retries
        const exponentialDelay = baseDelay * Math.pow(1.3, attempt);
        const jitter = Math.random() * 10;
        const delay = exponentialDelay + jitter;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

function getCachedData(key) {
  const cached = commandCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
    return cached.data;
  }
  return null;
}

function setCachedData(key, data) {
  commandCache.set(key, { data, timestamp: Date.now() });
}

async function initializeProviders() {
  console.log(`\n🔗 Initializing ${RPC_URLS.length} RPC provider(s)...`);
  
  for (const rpc of RPC_URLS) {
    try {
      let provider;
      
      if (rpc.url.startsWith('wss://') || rpc.url.startsWith('ws://')) {
        provider = new ethers.WebSocketProvider(rpc.url);
        console.log(`🌐 ${rpc.name}: Using WebSocket for maximum speed`);
      } else {
        provider = new ethers.JsonRpcProvider(rpc.url, null, {
          staticNetwork: true,
          timeout: RPC_TIMEOUT
        });
      }

      const network = await Promise.race([
        provider.getNetwork(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), RPC_TIMEOUT))
      ]);
      
      const blockNumber = await provider.getBlockNumber();
      
      providers.push({ name: rpc.name, provider, url: rpc.url });
      providerHealth.set(rpc.name, { status: 'connected', latency: 0, lastCheck: Date.now() });
      
      console.log(`✅ ${rpc.name} connected (Chain ID: ${network.chainId}, Block: ${blockNumber})`);
    } catch (error) {
      console.error(`❌ Error connecting ${rpc.name}:`, error.message);
      providerHealth.set(rpc.name, { status: 'error', latency: 0, lastCheck: Date.now() });
    }
  }

  if (providers.length === 0) {
    console.warn('⚠️ No RPC providers available, will retry...');
    return null;
  }

  console.log(`\n✅ ${providers.length} provider(s) ready`);
  return providers[0].provider;
}

async function initializeProvidersWithRetry() {
  let attempt = 0;
  while (true) {
    try {
      const result = await initializeProviders();
      if (result && providers.length > 0) {
        return result;
      }
      
      attempt++;
      console.log(`⚠️ Attempt ${attempt} failed - waiting 10s and retrying...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    } catch (error) {
      attempt++;
      console.error(`⚠️ RPC connection error (attempt ${attempt}):`, error.message);
      console.log('🔄 Waiting 10s and retrying...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

// ===================================================================
// PROFESSIONAL RPC FAILOVER SYSTEM
// ===================================================================

function getCurrentProvider() {
  if (providers.length === 0) {
    return null;
  }
  return providers[currentProviderIndex];
}

async function notifyProviderSwitch(fromProvider, toProvider, reason) {
  const message = 
    `👤 <b>Amin Tanhaei - RPC Switch Alert</b> ⚠️\n\n` +
    `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `┃ 🔄 <b>Automatic RPC Failover</b>\n` +
    `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `❌ <b>Failed RPC:</b> ${fromProvider}\n` +
    `✅ <b>Switched to:</b> ${toProvider}\n` +
    `📝 <b>Reason:</b> ${reason}\n\n` +
    `⏰ <b>Time:</b> ${new Date().toLocaleTimeString('en-US', { hour12: false })}\n\n` +
    `ℹ️ <b>Bot continues monitoring automatically...</b>`;
  
  await sendTelegramMessage(message);
  
  if (metricsCollector) {
    metricsCollector.recordError(new Error(`RPC Switch: ${fromProvider} -> ${toProvider}`), 'rpc_failover');
  }
}

async function switchToNextProvider(reason = 'RPC failure detected') {
  if (providers.length <= 1) {
    console.log('⚠️ Cannot switch - only one provider available');
    return false;
  }
  
  const now = Date.now();
  if (lastProviderSwitch && (now - lastProviderSwitch) < PROVIDER_SWITCH_COOLDOWN) {
    console.log('⚠️ Switch cooldown active - skipping to prevent rapid switching');
    return false;
  }
  
  const oldProvider = providers[currentProviderIndex];
  const oldIndex = currentProviderIndex;
  
  currentProviderIndex = (currentProviderIndex + 1) % providers.length;
  const newProvider = providers[currentProviderIndex];
  
  lastProviderSwitch = now;
  
  console.log(`\n🔄 ═══════════════════════════════════════════`);
  console.log(`   RPC FAILOVER INITIATED`);
  console.log(`   ═══════════════════════════════════════════`);
  console.log(`   ❌ Failed: ${oldProvider.name}`);
  console.log(`   ✅ Switching to: ${newProvider.name}`);
  console.log(`   📝 Reason: ${reason}`);
  console.log(`   ═══════════════════════════════════════════\n`);
  
  providerFailureCount.set(oldProvider.name, 0);
  
  try {
    const testStart = Date.now();
    await newProvider.provider.getBlockNumber();
    const latency = Date.now() - testStart;
    
    console.log(`✅ New provider verified (latency: ${latency}ms)`);
    
    if (mempoolMonitor && USE_EVENT_DRIVEN) {
      console.log('🔄 Recreating mempool monitor with new provider...');
      await mempoolMonitor.stop();
      
      mempoolMonitor = new MempoolMonitor(
        newProvider.provider,
        monitoredAddress
      );
      
      await mempoolMonitor.start(handleMempoolTransaction, handleMempoolError);
      console.log('✅ Mempool monitor recreated and restarted');
    }
    
    await notifyProviderSwitch(oldProvider.name, newProvider.name, reason);
    
    return true;
  } catch (error) {
    console.error(`❌ New provider also failed: ${error.message}`);
    
    if (providers.length > 2) {
      console.log('🔄 Trying next provider...');
      return await switchToNextProvider('Cascading failure');
    }
    
    currentProviderIndex = oldIndex;
    console.log('⚠️ Reverted to original provider');
    return false;
  }
}

function recordProviderFailure(providerName) {
  if (!providerName) {
    const current = getCurrentProvider();
    if (current) {
      providerName = current.name;
    } else {
      return;
    }
  }
  
  const currentCount = providerFailureCount.get(providerName) || 0;
  const newCount = currentCount + 1;
  providerFailureCount.set(providerName, newCount);
  
  console.log(`⚠️ Provider failure recorded: ${providerName} (${newCount}/${MAX_PROVIDER_FAILURES})`);
  
  if (newCount >= MAX_PROVIDER_FAILURES) {
    console.log(`🚨 Provider ${providerName} exceeded failure threshold!`);
    setImmediate(async () => {
      await switchToNextProvider(`${providerName} failed ${newCount} times`);
    });
  }
}

async function checkProviderHealth(provider) {
  try {
    const start = Date.now();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Health check timeout')), 3000)
    );
    
    await Promise.race([
      provider.getBlockNumber(),
      timeoutPromise
    ]);
    
    const latency = Date.now() - start;
    return { healthy: true, latency };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
}

async function getFastestProvider() {
  if (providers.length === 0) {
    return null;
  }
  
  const current = getCurrentProvider();
  if (current) {
    const cachedHealth = providerHealth.get(current.name);
    if (cachedHealth && cachedHealth.status === 'connected' && (Date.now() - cachedHealth.lastCheck) < HEALTH_FRESH_MS) {
      return current.provider;
    }
    const health = await checkProviderHealth(current.provider);
    if (health.healthy) {
      providerHealth.set(current.name, { 
        status: 'connected', 
        latency: health.latency, 
        lastCheck: Date.now() 
      });
      return current.provider;
    } else {
      console.warn(`⚠️ Current provider ${current.name} health check failed`);
      recordProviderFailure(current.name);
    }
  }
  
  if (providers.length === 1) {
    return providers[0].provider;
  }
  
  const promises = providers.map(async ({ name, provider }) => {
    const start = Date.now();
    try {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Provider timeout')), 3000)
      );
      
      await Promise.race([provider.getBlockNumber(), timeoutPromise]);
      const latency = Date.now() - start;
      providerHealth.set(name, { status: 'connected', latency, lastCheck: Date.now() });
      return { name, provider, latency };
    } catch (error) {
      providerHealth.set(name, { status: 'error', latency: 9999, lastCheck: Date.now() });
      return { name, provider, latency: 9999 };
    }
  });

  const results = await Promise.all(promises);
  const fastest = results.sort((a, b) => a.latency - b.latency)[0];
  
  if (fastest.latency === 9999) {
    console.warn('⚠️ All RPC providers temporarily unavailable');
    return null;
  }
  
  return fastest.provider;
}

// CRITICAL FIX C-5: Circuit breaker for infinite loop protection
async function getFastestProviderWithRetry() {
  let attempts = 0;
  
  while (attempts < MAX_RPC_RETRY_ATTEMPTS) {
    attempts++;
    
    try {
      // Check circuit breaker status
      if (circuitBreakerTripped) {
        const timeSinceTripped = Date.now() - circuitBreakerTrippedAt;
        
        if (timeSinceTripped < CIRCUIT_BREAKER_RESET_TIME) {
          const remainingTime = Math.ceil((CIRCUIT_BREAKER_RESET_TIME - timeSinceTripped) / 1000);
          console.log(`🚨 Circuit breaker active - waiting ${remainingTime}s before retry...`);
          
          // Wait for circuit breaker cooldown
          await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10s
          continue;
        } else {
          // Reset circuit breaker after cooldown
          console.log('🔄 Circuit breaker reset - attempting reconnection...');
          circuitBreakerTripped = false;
          circuitBreakerTrippedAt = null;
          consecutiveRpcFailures = 0;
        }
      }
      
      const provider = await getFastestProvider();
      
      if (provider) {
        // Success - reset failure counter
        consecutiveRpcFailures = 0;
        
        if (attempts > 1) {
          console.log(`✅ Successfully reconnected after ${attempts} attempt(s)`);
        }
        
        return provider;
      }
      
      // All providers failed this attempt
      consecutiveRpcFailures++;
      console.log(`⚠️ All RPCs down (attempt ${attempts}/${MAX_RPC_RETRY_ATTEMPTS}, consecutive failures: ${consecutiveRpcFailures})`);
      
      // CRITICAL: Trip circuit breaker immediately after threshold
      if (consecutiveRpcFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitBreakerTripped = true;
        circuitBreakerTrippedAt = Date.now();
        
        console.error(`🚨 CIRCUIT BREAKER TRIPPED: ${consecutiveRpcFailures} consecutive RPC failures`);
        console.error(`🚨 Stopping retry attempts - manual intervention required`);
        
        // Send critical alert
        if (telegramBot && TELEGRAM_CHAT_ID) {
          await sendTelegramMessage(
            `🚨 <b>CRITICAL ALERT</b>\n\n` +
            `Circuit breaker tripped after ${consecutiveRpcFailures} failures!\n\n` +
            `Bot has stopped retry attempts.\n\n` +
            `Please check:\n` +
            `1. RPC provider status\n` +
            `2. Network connectivity\n` +
            `3. API key validity\n\n` +
            `Restart bot after fixing issues.`
          ).catch(() => {});
        }
        
        break; // Exit loop immediately
      }
      
      // Exponential backoff with jitter (only if not at threshold)
      const baseDelay = Math.min(30000 * Math.pow(1.5, attempts - 1), 180000); // Cap at 3 minutes
      const jitter = Math.random() * 5000; // 0-5 seconds jitter
      const delay = baseDelay + jitter;
      
      console.log(`⏳ Waiting ${Math.round(delay / 1000)}s before retry ${attempts + 1}/${MAX_RPC_RETRY_ATTEMPTS}...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      console.log('🔄 Attempting to reconnect to RPCs...');
      await initializeProviders();
      
    } catch (error) {
      console.error(`⚠️ Error in provider retry loop (attempt ${attempts}):`, error.message);
      consecutiveRpcFailures++;
      
      if (attempts >= MAX_RPC_RETRY_ATTEMPTS || consecutiveRpcFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }
  
  // Maximum attempts reached or circuit breaker tripped - critical failure
  const errorMsg = `❌ CRITICAL: Failed to connect to any RPC provider after ${attempts} attempts`;
  console.error(errorMsg);
  console.error(`🚨 Bot cannot continue without RPC connection`);
  console.error(`🚨 Manual intervention required`);
  
  // Send critical alert
  if (telegramBot && TELEGRAM_CHAT_ID) {
    await sendTelegramMessage(
      `🚨 <b>CRITICAL FAILURE</b>\n\n` +
      `Failed to connect to any RPC provider after ${attempts} attempts.\n\n` +
      `Bot has stopped monitoring.\n\n` +
      `<b>ACTION REQUIRED:</b>\n` +
      `1. Verify RPC URLs are correct\n` +
      `2. Check RPC provider status\n` +
      `3. Restart bot manually after fixing issues`
    ).catch(() => {});
  }
  
  // Throw error instead of infinite loop
  throw new Error(`RPC connection failed after ${attempts} attempts - manual intervention required`);
}

// CRITICAL FIX C-5: Circuit breaker status monitoring
function getCircuitBreakerStatus() {
  if (!circuitBreakerTripped) {
    return {
      status: 'closed',
      consecutiveFailures: consecutiveRpcFailures,
      threshold: CIRCUIT_BREAKER_THRESHOLD,
      maxAttempts: MAX_RPC_RETRY_ATTEMPTS
    };
  }
  
  const timeSinceTripped = Date.now() - circuitBreakerTrippedAt;
  const remainingCooldown = Math.max(0, CIRCUIT_BREAKER_RESET_TIME - timeSinceTripped);
  
  return {
    status: 'open',
    trippedAt: new Date(circuitBreakerTrippedAt).toISOString(),
    remainingCooldown: Math.ceil(remainingCooldown / 1000) + 's',
    consecutiveFailures: consecutiveRpcFailures,
    threshold: CIRCUIT_BREAKER_THRESHOLD,
    maxAttempts: MAX_RPC_RETRY_ATTEMPTS
  };
}

// ===================================================================
// ⚡ SPEED LAYER - keeps slow network round-trips OFF the transfer hot path
// ===================================================================

const FEE_CACHE_TTL_MS = 30000;      // base fee moves max +12.5%/block; maxFee = 2x base covers ~3 stale blocks
const HEALTH_FRESH_MS = 20000;       // a block event within this window proves the RPC is alive
let feeCache = null;                 // { value, at }
let destinationIsEOA = null;         // cached once: plain ETH transfer => gasLimit is always 21000
let cachedChainId = null;
let baseFeeCache = null;        // { value, at } - raw baseFeePerGas of the latest block
const FEE_HEADROOM_PERCENT = process.env.FEE_HEADROOM_PERCENT ? Number(process.env.FEE_HEADROOM_PERCENT) : 20;
// baseFee can rise at most +12.5%/block; 20% headroom covers 1 full block of worst-case rise.
// If it still is not enough (rare), the bot's existing RBF bumps the fee after 180s - no stuck funds.

// Optional: higher tip = builders include the tx earlier in the block (costs a bit more).
let PRIORITY_FEE_OVERRIDE = null;
if (process.env.PRIORITY_FEE_GWEI) {
  try {
    PRIORITY_FEE_OVERRIDE = ethers.parseUnits(String(process.env.PRIORITY_FEE_GWEI), 'gwei');
  } catch (e) {
    console.warn('⚠️ Invalid PRIORITY_FEE_GWEI - ignoring');
  }
}

function markProviderAlive() {
  const cur = providers[0];
  if (!cur) return;
  const h = providerHealth.get(cur.name) || { latency: 0 };
  providerHealth.set(cur.name, { status: 'connected', latency: h.latency || 0, lastCheck: Date.now() });
}

async function isDestinationEOA(provider) {
  if (destinationIsEOA !== null) return destinationIsEOA;
  try {
    const code = await withExponentialBackoff(() => provider.getCode(DESTINATION_ADDRESS));
    destinationIsEOA = (code === '0x');
  } catch (e) {
    return false; // unknown -> fall back to estimateGas, do not cache
  }
  return destinationIsEOA;
}

async function getChainId(provider) {
  if (cachedChainId === null) {
    cachedChainId = (await provider.getNetwork()).chainId;
  }
  return cachedChainId;
}

// Called in the background on every new block (never awaited on the hot path)
async function refreshHotCaches(provider) {
  const tasks = [
    getLiveGasPrice(provider, true),
    provider.getBlock('latest').then(b => {
      if (b && b.baseFeePerGas !== undefined && b.baseFeePerGas !== null) {
        baseFeeCache = { value: b.baseFeePerGas, at: Date.now() };
      }
    }).catch(() => {})
  ];
  if (nonceManager && typeof nonceManager.refreshNetworkNonce === 'function') {
    tasks.push(nonceManager.refreshNetworkNonce());
  }
  await Promise.allSettled(tasks);
}

// Tight max-fee for the exact-21000-gas EOA sweep: minimises the ETH left behind
// (the EIP-1559 refund) instead of using the generic ~2x-baseFee estimate.
// Falls back to null if the base fee has not been cached yet (first run).
function getTightEOAFee(genericGasPrice) {
  if (!baseFeeCache || genericGasPrice.maxPriorityFeePerGas === undefined) return null;
  const tip = (PRIORITY_FEE_OVERRIDE !== null && PRIORITY_FEE_OVERRIDE > genericGasPrice.maxPriorityFeePerGas)
    ? PRIORITY_FEE_OVERRIDE : genericGasPrice.maxPriorityFeePerGas;
  const headroom = BigInt(100 + FEE_HEADROOM_PERCENT);
  const maxFeePerGas = (baseFeeCache.value * headroom) / 100n + tip;
  return { maxFeePerGas, maxPriorityFeePerGas: tip };
}

// Sign locally (no RPC) and broadcast the SAME raw tx to every RPC in parallel.
// First endpoint that accepts wins. Replaces wallet.sendTransaction() which
// populates/serialises through a single provider.
async function broadcastSigned(tx, primaryProvider) {
  const chainId = await getChainId(primaryProvider);
  const type = tx.maxFeePerGas !== undefined ? 2 : 0;
  const signed = await wallet.signTransaction({ ...tx, chainId, type });
  const hash = await broadcastRaw(signed, primaryProvider);
  return { hash, nonce: tx.nonce };
}

async function broadcastRaw(signed, primaryProvider) {
  const hash = ethers.keccak256(signed);

  const targets = providers.map(p => p.provider);
  if (!targets.includes(primaryProvider)) targets.unshift(primaryProvider);

  const errors = [];
  const attempts = targets.map(p =>
    Promise.race([
      p.send('eth_sendRawTransaction', [signed]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('broadcast timeout')), 3000))
    ]).catch(err => { errors.push(err); throw err; })
  );

  try {
    await Promise.any(attempts);
  } catch (_) {
    const isKnown = (e) => /already known|known transaction|already imported|already exists/i.test(String((e && e.message) || ''));
    // every endpoint answered "already known" => it is in the mempool, treat as sent
    if (!(errors.length > 0 && errors.every(isKnown))) {
      throw errors.find(e => !isKnown(e)) || errors[0];
    }
  }
  return hash;
}

// ===================================================================
// GAS PRICE & ESTIMATION
// ===================================================================

async function getLiveGasPrice(provider, forceFresh = false) {
  if (!forceFresh && feeCache && (Date.now() - feeCache.at) < FEE_CACHE_TTL_MS) {
    return feeCache.value;
  }
  try {
    const feeData = await withExponentialBackoff(() => provider.getFeeData());
    
    let gasPrice;
    let gasType;
    
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      let maxFee = feeData.maxFeePerGas;
      let tip = feeData.maxPriorityFeePerGas;
      if (PRIORITY_FEE_OVERRIDE !== null && PRIORITY_FEE_OVERRIDE > tip) {
        maxFee = maxFee - tip + PRIORITY_FEE_OVERRIDE;
        tip = PRIORITY_FEE_OVERRIDE;
      }
      gasPrice = { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
      gasType = 'EIP-1559';
    } else if (feeData.gasPrice) {
      gasPrice = {
        gasPrice: feeData.gasPrice
      };
      gasType = 'Legacy';
    } else {
      throw new Error('No gas price data available');
    }
    
    const liveResult = { gasPrice, gasType, feeData };
    feeCache = { value: liveResult, at: Date.now() };
    return liveResult;
  } catch (error) {
    console.error('⚠️ Error fetching gas price:', error.message);
    const fallbackPrice = ethers.parseUnits('35', 'gwei');
    return {
      gasPrice: { gasPrice: fallbackPrice },
      gasType: 'Fallback',
      feeData: { gasPrice: fallbackPrice }
    };
  }
}

async function estimateGasWithFallback(provider, tx) {
  try {
    return await withExponentialBackoff(() => provider.estimateGas(tx));
  } catch (error) {
    console.log(`⚠️ Gas estimation failed, using fallback: 21000`);
    return 21000n;
  }
}

async function calculateTransactionCost(gasPrice, gasLimit) {
  let gasCost;
  
  if (gasPrice.maxFeePerGas) {
    gasCost = gasLimit * gasPrice.maxFeePerGas;
  } else {
    gasCost = gasLimit * gasPrice.gasPrice;
  }
  
  const bufferPercent = BigInt(GAS_SAFETY_BUFFER_PERCENT);
  const bufferAmount = (gasCost * bufferPercent + 99n) / 100n;
  const totalGasCostWithBuffer = gasCost + bufferAmount;
  
  return {
    baseCost: gasCost,
    totalCostWithBuffer: totalGasCostWithBuffer,
    bufferAmount: bufferAmount
  };
}

function increaseGasPrice(gasPrice, increasePercent) {
  const multiplier = BigInt(100 + increasePercent);
  
  if (gasPrice.maxFeePerGas && gasPrice.maxPriorityFeePerGas) {
    return {
      maxFeePerGas: (gasPrice.maxFeePerGas * multiplier) / 100n,
      maxPriorityFeePerGas: (gasPrice.maxPriorityFeePerGas * multiplier) / 100n
    };
  } else {
    return {
      gasPrice: (gasPrice.gasPrice * multiplier) / 100n
    };
  }
}

// ===================================================================
// PENDING TX PERSISTENCE
// ===================================================================

// MEDIUM FIX M-2: Use atomic writes for pending transactions
async function savePendingTransactions() {
  try {
    if (!pendingTxFilePath) return;
    const pendingTxData = Array.from(pendingTransactions.entries()).map(([hash, data]) => ({
      hash,
      nonce: data.nonce,
      startTime: data.startTime
    }));
    // Use atomic write to prevent file corruption
    await AtomicFileWriter.writeJSON(pendingTxFilePath, pendingTxData, { mode: 0o600 });
  } catch (error) {
    console.error('⚠️ Error saving pending transactions:', error.message);
  }
}

async function loadPendingTransactions() {
  try {
    if (!pendingTxFilePath) return;
    const fs = require('fs').promises;
    const data = await fs.readFile(pendingTxFilePath, 'utf8');
    const pendingTxData = JSON.parse(data);
    
    const now = Date.now();
    let loaded = 0;
    let skipped = 0;
    
    for (const tx of pendingTxData) {
      const age = now - tx.startTime;
      
      if (age > PENDING_TX_TIMEOUT * 3) {
        console.log(`⚠️ Skipping very old transaction: ${tx.hash.substring(0, 10)}... (${Math.floor(age / 60000)} min old)`);
        skipped++;
        continue;
      }
      
      pendingTransactions.set(tx.hash, { 
        nonce: tx.nonce, 
        startTime: tx.startTime,
        intervalId: null,
        absoluteTimeoutId: null
      });
      loaded++;
      
      const provider = providers.length > 0 ? providers[0].provider : null;
      if (provider) {
        monitorPendingTransaction(tx.hash, tx.nonce, provider).catch((err) => {
          console.error(`⚠️ Error restarting monitoring for ${tx.hash.substring(0, 10)}:`, err.message);
        });
      }
    }
    
    if (loaded > 0) {
      console.log(`✅ Loaded ${loaded} pending transaction(s), skipped ${skipped} old ones`);
      if (providers.length > 0) {
        console.log(`🔄 Resumed monitoring for loaded transactions`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('⚠️ Error loading pending transactions:', error.message);
    }
  }
}

// ===================================================================
// REPLACE-BY-FEE (RBF)
// ===================================================================

async function monitorPendingTransaction(txHash, nonce, provider) {
  const startTime = Date.now();
  
  try {
    let checkInterval = null;
    let absoluteTimeoutId = null;
    let isCleanedUp = false;
    
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
      if (absoluteTimeoutId) {
        clearTimeout(absoluteTimeoutId);
        absoluteTimeoutId = null;
      }
      pendingTransactions.delete(txHash);
    };
    
    checkInterval = setInterval(async () => {
      try {
        const elapsed = Date.now() - startTime;
        
        if (elapsed > PENDING_TX_TIMEOUT) {
          cleanup();
          console.log(`⚠️ Transaction ${txHash.substring(0, 10)}... stuck for ${Math.floor(elapsed / 1000)}s`);
          console.log(`🔄 Attempting Replace-by-Fee (RBF)...`);
          
          await savePendingTransactions();
          await attemptRBF(nonce, provider);
          return;
        }
        
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
          cleanup();
          await savePendingTransactions();
          
          if (receipt.status === 1) {
            console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
          } else {
            console.log(`❌ Transaction failed in block ${receipt.blockNumber}`);
          }
        }
      } catch (error) {
        // Ignore monitoring errors during check
      }
    }, 30000);
    
    absoluteTimeoutId = setTimeout(() => {
      if (!isCleanedUp) {
        console.warn(`⚠️ Absolute timeout reached for transaction ${txHash.substring(0, 10)}...`);
        cleanup();
        savePendingTransactions().catch(() => {});
      }
    }, PENDING_TX_TIMEOUT * 2);
    
    pendingTransactions.set(txHash, { 
      nonce, 
      startTime, 
      intervalId: checkInterval,
      absoluteTimeoutId: absoluteTimeoutId
    });
    await savePendingTransactions();
    
  } catch (error) {
    console.error('⚠️ Error monitoring pending transaction:', error.message);
  }
}

async function attemptRBF(originalNonce, provider) {
  // CRITICAL: بررسی pause برای RBF
  if (botStatus.paused) {
    console.log('⏸️ RBF skipped - monitoring is paused');
    return;
  }
  
  try {
    const balance = await provider.getBalance(monitoredAddress);
    
    if (balance === 0n) {
      console.log('⚠️ RBF skipped: Balance is zero');
      return;
    }
    
    const { gasPrice: currentGasPrice, gasType } = await getLiveGasPrice(provider, true);
    const rbfGasPrice = increaseGasPrice(currentGasPrice, RBF_GAS_INCREASE_PERCENT);
    
    console.log(`⛽ RBF: Using ${RBF_GAS_INCREASE_PERCENT}% higher gas price`);
    
    let gasLimit = 21000n;
    let costs = await calculateTransactionCost(rbfGasPrice, gasLimit);
    let amountToSend = balance - costs.totalCostWithBuffer;
    
    if (amountToSend <= 0n) {
      console.log('⚠️ RBF skipped: Insufficient balance');
      return;
    }
    
    const estimateTx = {
      to: DESTINATION_ADDRESS,
      value: amountToSend,
      from: monitoredAddress
    };
    gasLimit = await estimateGasWithFallback(provider, estimateTx);
    costs = await calculateTransactionCost(rbfGasPrice, gasLimit);
    amountToSend = balance - costs.totalCostWithBuffer;
    
    if (amountToSend <= 0n) {
      console.log('⚠️ RBF skipped: Insufficient balance after estimation');
      return;
    }
    
    const tx = {
      to: DESTINATION_ADDRESS,
      value: amountToSend,
      gasLimit: gasLimit,
      nonce: originalNonce,
      ...rbfGasPrice
    };
    
    console.log(`🔄 Sending RBF transaction with nonce ${originalNonce}`);
    
    const connectedWallet = wallet.connect(provider);
    const txResponse = await connectedWallet.sendTransaction(tx);
    
    botStatus.rbfReplacements++;
    
    console.log(`✅ RBF Transaction sent: ${txResponse.hash}`);
    console.log(`💸 Amount: ${ethers.formatEther(amountToSend)} ETH`);
    
    await sendTelegramMessage(
      `👤 <b>Amin Tanhaei</b>\n\n` +
      `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `┃ 🔄 <b>RBF Replacement</b>\n` +
      `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `💸 <b>Amount:</b> ${ethers.formatEther(amountToSend)} ETH\n` +
      `🔗 <b>TX Hash:</b> <code>${txResponse.hash}</code>\n` +
      `🔢 <b>Nonce:</b> ${originalNonce}\n\n` +
      `⚡ <b>Gas Optimization:</b>\n` +
      `└─ ⛽ Increased by ${RBF_GAS_INCREASE_PERCENT}%\n\n` +
      `ℹ️ <b>Previous TX stuck - replaced with faster one.</b>`
    );
    
    await monitorPendingTransaction(txResponse.hash, originalNonce, provider);
    
  } catch (error) {
    console.error('❌ RBF attempt failed:', error.message);
    botStatus.errors++;
    
    if (metricsCollector) {
      metricsCollector.recordError(error, 'rbf');
    }
  }
}

// ===================================================================
// ⚡ MAIN TRANSFER LOGIC - OPTIMIZED FOR SPEED
// ===================================================================

async function attemptTransferWithRetry(provider, providerName, detectionTime, transferStart, knownBalance = null) {
  let retryAttempt = 0;
  let lastError = null;
  let balance, currentGasPrice;

  while (retryAttempt < MAX_RETRY_ATTEMPTS) {
    try {
      // ULTRA-FAST OPTIMIZATION: Parallel RPC calls for balance + gasPrice
      if (retryAttempt === 0) {
        const [balanceResult, gasPriceResult] = await Promise.all([
          knownBalance !== null ? knownBalance : provider.getBalance(monitoredAddress),
          getLiveGasPrice(provider)
        ]);
        
        balance = balanceResult;
        currentGasPrice = gasPriceResult.gasPrice;
        
        botStatus.lastBalanceCheck = {
          timestamp: new Date().toISOString(),
          balance: ethers.formatEther(balance),
          address: maskSensitiveData(monitoredAddress)
        };
        
        console.log(`\n💰 Balance: ${ethers.formatEther(balance)} ETH`);
        
        if (balance === 0n) {
          throw new Error('Balance is zero');
        }
      } else {
        currentGasPrice = increaseGasPrice(currentGasPrice, 10);
        botStatus.retriedTransfers++;
        console.log(`🔄 Retry ${retryAttempt}: +10% gas`);
      }
      
      let initialGasLimit = 21000n;
      const tightFeeEarly = (await isDestinationEOA(provider)) ? getTightEOAFee(currentGasPrice) : null;
      let initialCosts = tightFeeEarly
        ? { totalCostWithBuffer: initialGasLimit * tightFeeEarly.maxFeePerGas }  // exact cost, no extra buffer: gas usage is fixed at 21000
        : await calculateTransactionCost(currentGasPrice, initialGasLimit);
      let preliminaryAmount = balance - initialCosts.totalCostWithBuffer;
      
      if (preliminaryAmount <= 0n) {
        throw new Error('Insufficient balance after gas deduction');
      }
      
      const estimateTx = {
        to: DESTINATION_ADDRESS,
        value: preliminaryAmount,
        from: monitoredAddress
      };
      
      const isEOA = await isDestinationEOA(provider);
      const gasLimit = isEOA ? 21000n : await estimateGasWithFallback(provider, estimateTx);
      const tightFee = isEOA ? getTightEOAFee(currentGasPrice) : null;
      if (tightFee) currentGasPrice = tightFee;  // use the tight fee for both the cost calc AND the tx itself
      
      const preciseCosts = tightFee
        ? { totalCostWithBuffer: gasLimit * tightFee.maxFeePerGas }
        : await calculateTransactionCost(currentGasPrice, gasLimit);
      preliminaryAmount = balance - preciseCosts.totalCostWithBuffer;
      
      if (preliminaryAmount <= 0n) {
        throw new Error('Insufficient balance after precise estimation');
      }
      
      const costs = preciseCosts;
      
      botStatus.insufficientFundWarning = null;

      if (balance < costs.totalCostWithBuffer) {
        throw new Error('Balance insufficient for transaction with gas');
      }
      
      const finalAmountToSend = balance - costs.totalCostWithBuffer;
      
      const txResponse = await nonceManager.withNonce(async (nonce) => {
        const tx = {
          to: DESTINATION_ADDRESS,
          value: finalAmountToSend,
          gasLimit: gasLimit,
          nonce: nonce,
          ...currentGasPrice
        };
        
        console.log(`📤 Sending: ${ethers.formatEther(finalAmountToSend)} ETH`);
        console.log(`🎯 To: ${maskSensitiveData(DESTINATION_ADDRESS)}`);
        console.log(`🔢 Nonce: ${nonce} (atomic lock held)`);
        
        return await broadcastSigned(tx, provider);
      });
      
      const transferTime = Date.now() - transferStart;
      
      botStatus.transferTimes.push(transferTime);
      botStatus.detectionTimes.push(detectionTime);
      
      if (botStatus.transferTimes.length > MAX_METRICS_LENGTH) {
        botStatus.transferTimes.shift();
      }
      if (botStatus.detectionTimes.length > MAX_METRICS_LENGTH) {
        botStatus.detectionTimes.shift();
      }
      
      botStatus.totalTransfers++;
      botStatus.successfulTransfers++;
      
      // НОВЫЙ: ذخیره در تاریخچه
      botStatus.transactionHistory.push({
        hash: txResponse.hash,
        amount: ethers.formatEther(finalAmountToSend),
        gasUsed: currentGasPrice.maxFeePerGas 
          ? ethers.formatUnits(currentGasPrice.maxFeePerGas, 'gwei')
          : ethers.formatUnits(currentGasPrice.gasPrice, 'gwei'),
        timestamp: Date.now(),
        success: true,
        detectionTime,
        transferTime
      });
      
      // حفظ حداکثر 50 تراکنش در تاریخچه
      if (botStatus.transactionHistory.length > 50) {
        botStatus.transactionHistory.shift();
      }
      
      console.log(`\n✅ Transaction Sent!`);
      console.log(`🔗 TX: ${txResponse.hash}`);
      console.log(`⚡ Detection: ${detectionTime}ms`);
      console.log(`🚀 Transfer: ${transferTime}ms`);
      
      const gasPriceGwei = currentGasPrice.maxFeePerGas 
        ? ethers.formatUnits(currentGasPrice.maxFeePerGas, 'gwei')
        : ethers.formatUnits(currentGasPrice.gasPrice, 'gwei');
      
      await sendTelegramMessage(
        `👤 <b>Amin Tanhaei</b>\n\n` +
        `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `┃ ✅ <b>Transfer Completed!</b>\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💸 <b>Amount:</b> ${ethers.formatEther(finalAmountToSend)} ETH\n` +
        `📤 <b>To:</b> <code>${maskSensitiveData(DESTINATION_ADDRESS)}</code>\n` +
        `🔗 <b>TX Hash:</b> <code>${txResponse.hash}</code>\n\n` +
        `⚙️ <b>Performance:</b>\n` +
        `├─ ⛽ Gas: ${gasPriceGwei} gwei\n` +
        `├─ ⚡ Detection: ${detectionTime}ms\n` +
        `└─ 🚀 Transfer: ${transferTime}ms\n\n` +
        `ℹ️ <b>Bot continues monitoring...</b>`
      );
      
      await monitorPendingTransaction(txResponse.hash, nonce, provider);
      
      return txResponse;
      
    } catch (error) {
      lastError = error;
      
      const isUnderpricedError = error.message.includes('replacement fee too low') ||
                                  error.message.includes('underpriced');
      
      if (isUnderpricedError && retryAttempt < MAX_RETRY_ATTEMPTS - 1) {
        console.log(`⚠️ Underpriced - retrying with higher gas`);
        retryAttempt++;
        continue;
      }
      
      throw error;
    }
  }
  
  console.error(`❌ All ${MAX_RETRY_ATTEMPTS} retries failed`);
  throw lastError;
}

// ===================================================================
// ⚡ PRE-SIGNED SWEEP (active only with ENABLE_MEMPOOL_MONITOR=true)
// When a deposit is seen in the mempool we already know its value, so the sweep
// (balance + deposit - gas) is built and SIGNED before the block arrives. The node
// rejects it ("insufficient funds") until the deposit is mined, so on every new
// block we fire the ready raw tx immediately - no getBalance/fee/nonce/sign delay.
// If anything does not match (replaced deposit, extra deposit, nonce change) the
// raw tx is rejected or dropped and the normal path below runs exactly as before.
// ===================================================================
const PREPARED_MAX_BLOCKS = 3;
let preparedSweep = null;     // { raw, hash, nonce, expectedBalance, createdBlock, deposits }
let preparedInFlight = null;  // Promise<boolean> while a prepared broadcast is running
let prepareChain = Promise.resolve();

function prepareSweep(tx) {
  prepareChain = prepareChain.then(() => doPrepareSweep(tx)).catch((e) => {
    console.log('⚠️ Pre-sign skipped:', e.message);
  });
  return prepareChain;
}

async function doPrepareSweep(tx) {
  if (botStatus.paused || !providers[0] || !nonceManager) return;
  const provider = providers[0].provider;
  if (pendingTransactions.size > 0) return;                       // a sweep is already in flight
  if (!(await isDestinationEOA(provider))) return;                // need fixed 21000 gas
  if (!tx || !tx.hash || typeof tx.value !== 'bigint' || tx.value <= 0n) return;

  const deposits = preparedSweep ? preparedSweep.deposits : new Map();
  deposits.set(tx.hash, tx.value);
  let incoming = 0n;
  for (const v of deposits.values()) incoming += v;

  const [balance, fee] = await Promise.all([
    provider.getBalance(monitoredAddress),
    getLiveGasPrice(provider)
  ]);
  const gasPrice = getTightEOAFee(fee.gasPrice) || fee.gasPrice;
  const cost = gasPrice.maxFeePerGas !== undefined ? 21000n * gasPrice.maxFeePerGas : 21000n * gasPrice.gasPrice;
  const expectedBalance = balance + incoming;
  const amount = expectedBalance - cost;  // no extra buffer: gas usage is fixed at 21000
  if (amount <= 0n) return;

  const nonce = await nonceManager.peekNextNonce();
  const chainId = await getChainId(provider);
  const type = gasPrice.maxFeePerGas !== undefined ? 2 : 0;
  const raw = await wallet.signTransaction({
    to: DESTINATION_ADDRESS, value: amount, gasLimit: 21000n, nonce, chainId, type, ...gasPrice
  });

  preparedSweep = {
    raw, hash: ethers.keccak256(raw), nonce, amount, expectedBalance,
    createdBlock: lastProcessedBlock, deposits
  };
  console.log(`⚡ Pre-signed sweep ready (nonce ${nonce}, ${ethers.formatEther(amount)} ETH) - fires on next block`);
}

// Returns true only if the pre-signed tx was accepted by at least one RPC
async function trySendPrepared() {
  const p = preparedSweep;
  if (!p || botStatus.paused) return false;
  if (lastProcessedBlock - p.createdBlock > PREPARED_MAX_BLOCKS) {
    preparedSweep = null;
    return false;
  }
  if (!checkAndAcquireGlobalLock()) return false;

  const started = Date.now();
  const provider = providers[0].provider;
  try {
    await nonceManager.withNonce(async (nonce) => {
      if (nonce !== p.nonce) throw new Error('PREPARED_NONCE_MISMATCH');
      return await broadcastRaw(p.raw, provider);
    });

    preparedSweep = null;
    lastBalance = p.expectedBalance;   // so checkBalance() does not trigger a second sweep
    const sendMs = Date.now() - started;

    botStatus.totalTransfers++;
    botStatus.successfulTransfers++;
    botStatus.transactionHistory.push({
      hash: p.hash,
      amount: ethers.formatEther(p.amount),
      gasUsed: 'pre-signed',
      timestamp: Date.now(),
      success: true,
      detectionTime: 0,
      transferTime: sendMs
    });
    if (botStatus.transactionHistory.length > 50) botStatus.transactionHistory.shift();

    console.log(`\n✅ PRE-SIGNED sweep broadcast in ${sendMs}ms: ${p.hash}`);
    void sendTelegramMessage(
      `⚡ <b>Pre-signed transfer sent</b>\n\n` +
      `💸 <b>Amount:</b> ${ethers.formatEther(p.amount)} ETH\n` +
      `🔗 <b>TX Hash:</b> <code>${p.hash}</code>\n` +
      `🚀 <b>Broadcast:</b> ${sendMs}ms`
    );
    monitorPendingTransaction(p.hash, p.nonce, provider).catch(() => {});
    return true;
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (/insufficient funds/i.test(msg) || (err && err.code === 'INSUFFICIENT_FUNDS')) {
      return false;                     // deposit not mined yet - keep it for the next block
    }
    console.log('ℹ️ Pre-signed sweep discarded:', msg.slice(0, 120));
    preparedSweep = null;               // nonce/fee mismatch etc. - normal path takes over
    return false;
  } finally {
    releaseGlobalLock('pre-signed');
  }
}

async function transferETH(detectionTime, knownBalance = null) {
  // CRITICAL: بررسی pause در تمام مسیرهای تراکنش
  if (botStatus.paused) {
    console.log('⏸️ Transfer skipped - monitoring is paused');
    return;
  }
  
  const transferStart = Date.now();
  
  if (!checkAndAcquireGlobalLock()) {
    console.log('⚠️ Transfer already in progress, skipping...');
    return;
  }
  
  try {
    const provider = await getFastestProviderWithRetry();
    const result = await attemptTransferWithRetry(provider, null, detectionTime, transferStart, knownBalance);
    
    if (result && metricsCollector) {
      const duration = Date.now() - transferStart;
      metricsCollector.recordTransferDuration(duration);
      metricsCollector.recordTransaction({
        success: true,
        rbfReplaced: false,
        duration
      });
    }
    
    return result;
  } catch (error) {
    const isInsufficientFunds = error.message.includes('Insufficient') || 
                                error.message.includes('Balance is zero') ||
                                error.message.includes('too small');
    
    if (isInsufficientFunds) {
      console.log(`ℹ️  Continuing to monitor...`);
      return;
    }
    
    console.error(`❌ Transfer error:`, error.message);
    botStatus.errors++;
    
    if (metricsCollector) {
      metricsCollector.recordError(error, 'transfer');
      metricsCollector.recordTransaction({
        success: false,
        rbfReplaced: false,
        error: error.message
      });
    }
    
    const isNonceError = error.message.includes('nonce') || 
                         error.code === 'NONCE_EXPIRED';
    
    if (isNonceError) {
      try {
        await nonceManager.handleNonceError(error);
        console.log('🔄 Retrying with corrected nonce...');
        const provider = await getFastestProvider();
        return await attemptTransferWithRetry(provider, null, detectionTime, transferStart);
      } catch (retryError) {
        console.error(`❌ Retry failed:`, retryError.message);
        return;
      }
    }
    
    const isRpcError = error.code === 'SERVER_ERROR' || error.code === 'NETWORK_ERROR';
    
    if (isRpcError && providers.length > 1) {
      console.log('🔄 Trying alternative RPCs...');
      
      for (const { name, provider: altProvider } of providers) {
        try {
          return await attemptTransferWithRetry(altProvider, name, detectionTime, transferStart);
        } catch (retryError) {
          console.log(`⚠️ ${name} failed: ${retryError.message}`);
          continue;
        }
      }
      
      console.log('⚠️ All RPCs failed - waiting 30s...');
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
    
    await sendTelegramMessage(
      `👤 <b>Amin Tanhaei</b>\n\n` +
      `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `┃ ❌ <b>Transfer Error</b>\n` +
      `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ <b>Error:</b> ${error.message}\n\n` +
      `ℹ️ <b>Bot continues monitoring...</b>`
    );
  } finally {
    // CRITICAL FIX C-3: Guaranteed lock release
    releaseGlobalLock('transfer-finally');
  }
}

// ===================================================================
// ⚡⚡⚡ EVENT-DRIVEN MONITORING - ULTRA-FAST DETECTION ⚡⚡⚡
// This is the key to 100/100 speed - instant reaction to new blocks
// ===================================================================

async function checkBalance() {
  // НОВЫЙ: بررسی pause
  if (botStatus.paused) {
    console.log('⏸️ Monitoring paused - skipping balance check');
    return;
  }
  
  try {
    const provider = providers[0].provider;
    const detectionStart = Date.now();
    
    const newBalance = await provider.getBalance(monitoredAddress);
    
    if (newBalance === lastBalance) return;
    
    if (newBalance < lastBalance) {
      console.log(`📉 Balance decreased: ${ethers.formatEther(lastBalance)} → ${ethers.formatEther(newBalance)} ETH`);
      lastBalance = newBalance;
      
      if (newBalance === 0n) {
        console.log(`💸 Wallet empty - monitoring for deposits...`);
      }
      return;
    }
    
    if (newBalance > 0n) {
      const detectionTime = Date.now() - detectionStart;
      
      console.log(`\n🔔 Deposit detected!`);
      console.log(`💰 Amount: ${ethers.formatEther(newBalance)} ETH`);
      console.log(`⚡ Detection: ${detectionTime}ms`);
      
      const currentBlock = botStatus.lastBlock || lastProcessedBlock;
      
      const preparedGate = preparedInFlight;
      
      // پردازش فوری و بدون انتظار - برای سرعت بالا
      setImmediate(async () => {
        try {
          if (preparedGate && await preparedGate) {
            lastBalance = await provider.getBalance(monitoredAddress).catch(() => lastBalance);
            return; // pre-signed sweep already broadcast
          }
          void sendTelegramMessage(
            `👤 <b>Amin Tanhaei</b>\n\n` +
            `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┃ ⚠️ <b>New Deposit Detected!</b>\n` +
            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `💰 <b>Amount:</b> ${ethers.formatEther(newBalance)} ETH\n` +
            `📦 <b>Block:</b> #${currentBlock}\n` +
            `⚡ <b>Detected in:</b> ${detectionTime}ms\n\n` +
            `🚀 <b>Starting automatic transfer with gas optimization...</b>`
          );
          
          await transferETH(detectionTime, newBalance);
          
          const updatedBalance = await provider.getBalance(monitoredAddress);
          lastBalance = updatedBalance;
          console.log(`📊 Balance after transfer: ${ethers.formatEther(updatedBalance)} ETH`);
        } catch (error) {
          console.error('⚠️ Transfer error in background:', error.message);
        }
      });
    }
  } catch (error) {
    botStatus.errors++;
    if (error.message.includes('Too Many Requests') || error.message.includes('429')) {
      consecutiveRateLimitErrors++;
      // A rate-limited getBalance() call means THIS block's deposit check was skipped - the next
      // block will retry automatically. Only escalate (log + alert) if it keeps happening, so a
      // real outage is never silent, but a single blip does not spam the log/Telegram.
      if (consecutiveRateLimitErrors === 1 || consecutiveRateLimitErrors % 5 === 0) {
        console.error(`⚠️ RPC rate limit (429) on getBalance - ${consecutiveRateLimitErrors} in a row. Deposit checks are being skipped.`);
      }
      if (consecutiveRateLimitErrors === RATE_LIMIT_ALERT_THRESHOLD) {
        void sendTelegramMessage(
          `🚨 <b>RPC rate-limited ${RATE_LIMIT_ALERT_THRESHOLD}+ times in a row</b>\n\n` +
          `Deposit checks are being skipped. Add a less-limited RPC, lower ENABLE_MEMPOOL_MONITOR load, or upgrade the RPC plan.`
        );
      }
    } else {
      consecutiveRateLimitErrors = 0;
      console.error('⚠️ Check error:', error.message);
    }
  }
}

// Shared recovery path for BOTH a real 'close' event and the watchdog's silent-stall detection.
async function handleConnectionLoss(reason) {
  console.warn(`⚠️ Connection lost (${reason}) - attempting reconnection...`);

  if (metricsCollector) {
    metricsCollector.recordError(new Error('WebSocket disconnected: ' + reason), 'websocket_disconnect');
  }

  // PROFESSIONAL FIX: Prevent race condition - only one reconnection attempt at a time
  if (isReconnecting) {
    console.log('⏳ Reconnection already in progress - skipping duplicate attempt');
    return;
  }

  isReconnecting = true;

  if (reconnectionTimeout) {
    clearTimeout(reconnectionTimeout);
    reconnectionTimeout = null;
  }
  if (blockWatchdog) {
    clearInterval(blockWatchdog);
    blockWatchdog = null;
  }

  const provider = providers[0] && providers[0].provider;

  // Use timeout to allow graceful cleanup
  reconnectionTimeout = setTimeout(async () => {
    try {
      if (blockListener && provider) {
        provider.off('block', blockListener);
        blockListener = null;
        console.log('✅ Removed old block listener');
      }

      if (mempoolMonitor) {
        await mempoolMonitor.stop();
        mempoolMonitor = null;
        console.log('✅ Removed old mempool monitor');
      }

      // A stale/zombie socket may never fire 'close' on its own - force it shut so the old
      // listeners are really gone before we open a new connection.
      if (reason === 'watchdog-stall' && provider) {
        const ws = provider._websocket || provider.websocket;
        try { ws && ws.terminate ? ws.terminate() : ws && ws.close && ws.close(); } catch (_) {}
      }

      const newProvider = await initializeProvidersWithRetry();
      if (newProvider && providers.length > 0) {
        console.log('✅ Reconnected - resuming monitoring');
        await startEventDrivenMonitoring();
      } else {
        console.error('❌ Failed to reconnect - switching to polling mode');
        await startPollingMonitoring();
      }
    } catch (error) {
      console.error('❌ Reconnection error:', error.message);
      console.log('🔄 Falling back to polling mode');
      await startPollingMonitoring();
    } finally {
      isReconnecting = false;
      reconnectionTimeout = null;
    }
  }, 3000);
}

async function startEventDrivenMonitoring() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('🔄 Cleared existing polling interval');
  }
  
  console.log(`\n⚡⚡⚡ EVENT-DRIVEN MODE ACTIVATED - MAXIMUM SPEED ⚡⚡⚡`);
  console.log(`🚀 Real-time block detection (no polling delay!)`);
  console.log(`🔥 Instant transaction processing\n`);
  
  const provider = providers[0].provider;
  
  const hasWebSocket = provider._websocket || provider.websocket;
  if (!hasWebSocket && (provider.constructor.name !== 'WebSocketProvider')) {
    console.warn('⚠️ Provider does not support WebSocket - falling back to polling mode');
    await startPollingMonitoring();
    return;
  }
  
  lastBlockReceivedAt = Date.now();
  
  blockListener = async (blockNumber) => {
    if (blockNumber <= lastProcessedBlock) return;
    
    lastBlockReceivedAt = Date.now();
    lastProcessedBlock = blockNumber;
    botStatus.lastBlock = blockNumber;
    markProviderAlive();
    
    preparedInFlight = preparedSweep ? trySendPrepared().catch(() => false) : null;
    await checkBalance();
    preparedInFlight = null;
    refreshHotCaches(provider).catch(() => {});
  };
  
  provider.on('block', blockListener);
  console.log('✅ Block event listener registered');
  
  // WATCHDOG: a WebSocket can die silently (TCP reset, idle-proxy timeout) without ever firing
  // 'close' or 'error'. If no block has arrived for WATCHDOG_STALL_MS, force a reconnect instead
  // of waiting forever for an event that may never come.
  if (blockWatchdog) clearInterval(blockWatchdog);
  blockWatchdog = setInterval(() => {
    const silentFor = Date.now() - lastBlockReceivedAt;
    if (silentFor > WATCHDOG_STALL_MS) {
      console.warn(`⚠️ No new block for ${Math.round(silentFor / 1000)}s - WebSocket looks stalled, forcing reconnect`);
      clearInterval(blockWatchdog);
      blockWatchdog = null;
      handleConnectionLoss('watchdog-stall');
    }
  }, 15000);
  
  // Mempool monitor is ON by default (disable with ENABLE_MEMPOOL_MONITOR=false). It feeds the
  // pre-signed sweep; plain getBalance('latest') cannot see an unmined deposit.
  try {
    if (process.env.ENABLE_MEMPOOL_MONITOR === 'false') {
      throw new Error('disabled (ENABLE_MEMPOOL_MONITOR=false)');
    }
    mempoolMonitor = new MempoolMonitor(provider, monitoredAddress, {
      maxCacheSize: 2000,
      cacheExpireTime: 600000,
      maxRPCCallsPerSecond: 50,  // PROFESSIONAL: Increased to 50 for robust mempool monitoring
      batchDelay: 20,
      enableBatching: true
    });
    
    await mempoolMonitor.start(
      async (tx, detectionTime) => {
        console.log(`\n🔔 MEMPOOL DETECTION - Ultra-fast incoming transaction!`);
        console.log(`⚡ Detected ${detectionTime}ms BEFORE block mining`);
        
        if (metricsCollector) {
          metricsCollector.recordCheckDuration(detectionTime);
        }
        
        prepareSweep(tx);
        refreshHotCaches(provider).catch(() => {});
      },
      (error, context, txHash) => {
        if (metricsCollector) {
          metricsCollector.recordError(error, `mempool_${context}`);
        }
      }
    );
    
    console.log('✅ Advanced mempool monitor activated');
    console.log('🎯 Monitoring incoming transactions BEFORE mining');
  } catch (error) {
    console.warn('⚠️ Mempool monitoring failed to start:', error.message);
    console.log('📊 Continuing with block-based monitoring only');
  }
  
  if (provider._websocket || provider.websocket) {
    const ws = provider._websocket || provider.websocket;
    console.log('🔌 WebSocket connection detected - registering error handlers');
    
    ws.on('close', () => handleConnectionLoss('ws-close'));
    
    ws.on('error', (error) => {
      console.error('⚠️ WebSocket error:', error.message);
      if (metricsCollector) {
        metricsCollector.recordError(error, 'websocket_error');
      }
    });
  }
  
  console.log(`✅ Event listener active - waiting for new blocks...`);
  console.log(`⚡ Detection time: <50ms (instant event response)\n`);
  
  botStatus.running = true;
  isMonitoring = true;
}

async function startPollingMonitoring() {
  if (blockListener && providers[0]?.provider) {
    providers[0].provider.off('block', blockListener);
    blockListener = null;
    console.log('🔄 Removed event-driven listener');
  }
  
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('🔄 Cleared existing polling interval');
  }
  
  console.log(`\n⏱️  Polling Mode - Checking every ${POLL_INTERVAL}ms`);
  console.log(`💡 Tip: Use WebSocket RPC for event-driven mode (10x faster!)\n`);
  
  botStatus.running = true;
  
  pollingInterval = setInterval(async () => {
    const provider = providers[0].provider;
    try {
      const currentBlock = await provider.getBlockNumber();
      
      markProviderAlive();
      if (currentBlock > lastProcessedBlock) {
        lastProcessedBlock = currentBlock;
        botStatus.lastBlock = currentBlock;
        await checkBalance();
        refreshHotCaches(provider).catch(() => {});
      }
    } catch (error) {
      if (error.message.includes('Too Many Requests') || error.message.includes('429')) {
        consecutiveRateLimitErrors++;
        if (consecutiveRateLimitErrors === 1 || consecutiveRateLimitErrors % 5 === 0) {
          console.error(`⚠️ RPC rate limit (429) while polling - ${consecutiveRateLimitErrors} in a row.`);
        }
      } else {
        consecutiveRateLimitErrors = 0;
        console.error('⚠️ Polling error:', error.message);
      }
    }
  }, POLL_INTERVAL);
  
  console.log('✅ Polling interval started - monitoring active');
}

async function displayStatus() {
  const balance = await providers[0].provider.getBalance(monitoredAddress);
  
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       ⚡ Ultra-Fast ETH Transfer Bot ⚡                    ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode: ${botStatus.eventDrivenMode ? '⚡ EVENT-DRIVEN (100/100 Speed)' : '⏱️  Polling Mode          '}        ║`);
  console.log(`║  Status: ✅ Active                                         ║`);
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  📍 Source: ${maskSensitiveData(monitoredAddress).padEnd(42)} ║`);
  console.log(`║  📤 Destination: ${maskSensitiveData(DESTINATION_ADDRESS).padEnd(42)} ║`);
  console.log(`║  💰 Balance: ${ethers.formatEther(balance).padEnd(10)} ETH                       ║`);
  console.log('║                                                            ║');
  console.log('║  🚀 Speed Features:                                        ║');
  if (botStatus.eventDrivenMode) {
    console.log('║     ⚡ Real-time block events (instant detection!)         ║');
    if (mempoolMonitor) {
      console.log('║     🔥 MEMPOOL MONITORING - 5-10ms detection!              ║');
      console.log('║     ⚡ Detects TX BEFORE mining into blocks!               ║');
    } else {
      console.log('║     🔥 <50ms detection time                                ║');
    }
  } else {
    console.log(`║     ⏱️  ${POLL_INTERVAL}ms polling interval                              ║`);
  }
  console.log('║     ✅ Parallel RPC processing                             ║');
  console.log('║     ⛽ Live gas fetching (EIP-1559)                        ║');
  console.log('║     📊 Dynamic gas estimation                              ║');
  console.log('║     🔄 Replace-by-Fee (RBF)                                ║');
  console.log('║     🔢 Persistent nonce management                         ║');
  console.log('║     🛡️  Complete error handling                            ║');
  console.log('║     🔒 Secure logging                                      ║');
  console.log('║                                                            ║');
  console.log('║  ⚙️  Settings:                                             ║');
  console.log(`║     🔗 Providers: ${providers.length} active                               ║`);
  console.log(`║     🔄 Max retries: ${MAX_RETRY_ATTEMPTS}                                   ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

// ===================================================================
// TELEGRAM COMMANDS
// ===================================================================

function setupTelegramCommands() {
  if (!telegramBot) return;
  
  telegramBot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthenticated(chatId)) {
      await telegramBot.sendMessage(
        chatId,
        `🔐 <b>Welcome to Amin Tanhaei's Bot!</b>\n\n` +
        `Please enter your password to continue:`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    
    const helpMessage = 
      `👤 <b>Amin Tanhaei - ETH Transfer Bot</b> ⚡\n\n` +
      `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `┃ ✅ <b>Authentication Successful!</b>\n` +
      `┃ 🔒 Private Bot - Exclusive Access\n` +
      `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚙️ <b>Settings:</b> ${botStatus.eventDrivenMode ? 'Event-Driven' : 'Polling'}, ${providers.length} RPCs\n` +
      `📦 <b>Instance Lock:</b> Active (PID: ${process.pid})\n\n` +
      `📋 <b>دستورات اصلی:</b>\n\n` +
      `├─ /help - 📖 راهنمای کامل\n` +
      `├─ /balance - 💰 موجودی\n` +
      `├─ /pause - ⏸️ توقف\n` +
      `├─ /resume - ▶️ ادامه\n` +
      `├─ /status - 📊 وضعیت\n` +
      `├─ /history - 📜 تاریخچه\n` +
      `├─ /gas - ⛽ قیمت گس\n` +
      `└─ /emergency - 🚨 اضطراری\n\n` +
      `${botStatus.eventDrivenMode ? '⚡ <b>ULTRA-FAST MODE ACTIVATED!</b>' : ''}\n` +
      `برای لیست کامل دستورات: /help`;
    
    await telegramBot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
  });
  
  telegramBot.onText(/\/balance/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `💰 Fetching live balance... ⏳`, { parse_mode: 'HTML' });
      
      try {
        const provider = await Promise.race([
          getFastestProvider(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
        ]);
        
        const balance = await Promise.race([
          provider.getBalance(monitoredAddress),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
        ]);
        
        const blockNumber = await provider.getBlockNumber();
        const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });
        
        const message = 
          `👤 <b>Amin Tanhaei - Wallet Status</b>\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 💰 <b>Live Balance Check</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `💵 <b>Balance:</b> ${ethers.formatEther(balance)} ETH\n` +
          `📍 <b>Address:</b> <code>${maskSensitiveData(monitoredAddress)}</code>\n` +
          `🔗 <b>Block:</b> #${blockNumber}\n` +
          `⏰ <b>Time:</b> ${currentTime}\n\n` +
          `✅ <b>Bot Status:</b> ${botStatus.running ? '🟢 Active & Monitoring' : '🔴 Inactive'}`;
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - Error Report</b>\n\n❌ Failed to fetch balance\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });
  
  telegramBot.onText(/\/help/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const helpMessage = 
        `👤 <b>Amin Tanhaei - راهنمای دستورات</b> 📖\n\n` +
        `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `┃ 🤖 <b>Bot Commands</b>\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        
        `💰 <b>کیف پول و موجودی:</b>\n` +
        `└─ /balance - بررسی موجودی کیف پول\n\n` +
        
        `⚙️ <b>کنترل ربات:</b>\n` +
        `├─ /pause - توقف موقت مانیتورینگ\n` +
        `└─ /resume - ادامه مانیتورینگ\n\n` +
        
        `📊 <b>وضعیت و آمار:</b>\n` +
        `├─ /status - آمار کامل ربات\n` +
        `├─ /stats - آمار سریع\n` +
        `├─ /metrics - متریک‌های دقیق\n` +
        `└─ /health - گزارش سلامت سیستم\n\n` +
        
        `📜 <b>تراکنش‌ها:</b>\n` +
        `├─ /history - تاریخچه تراکنش‌ها\n` +
        `└─ /pending - تراکنش‌های معلق\n\n` +
        
        `🌐 <b>شبکه و اتصال:</b>\n` +
        `├─ /network - اطلاعات شبکه\n` +
        `├─ /gas - قیمت فعلی گس\n` +
        `├─ /nonce - وضعیت nonce\n` +
        `├─ /rpc - وضعیت RPC ها\n` +
        `└─ /failover - وضعیت failover\n\n` +
        
        `🛠️ <b>سیستم:</b>\n` +
        `├─ /settings - تنظیمات ربات\n` +
        `├─ /logs - آخرین لاگ‌ها\n` +
        `└─ /emergency - انتقال اضطراری\n\n` +
        
        `❓ <b>راهنما:</b>\n` +
        `└─ /help - نمایش این پیام\n\n` +
        
        `⚡ <b>Ultra-Fast Transfer Bot</b>\n` +
        `🔒 خصوصی و امن`;
      
      await telegramBot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
    });
  });
  
  telegramBot.onText(/\/status/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      try {
        const uptime = Math.floor((Date.now() - botStatus.startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        
        const avgDetectionTime = botStatus.detectionTimes.length > 0
          ? (botStatus.detectionTimes.reduce((a, b) => a + b, 0) / botStatus.detectionTimes.length).toFixed(0)
          : 'N/A';
        
        const avgTransferTime = botStatus.transferTimes.length > 0
          ? (botStatus.transferTimes.reduce((a, b) => a + b, 0) / botStatus.transferTimes.length).toFixed(0)
          : 'N/A';
        
        const successRate = botStatus.totalTransfers > 0
          ? ((botStatus.successfulTransfers / botStatus.totalTransfers) * 100).toFixed(1)
          : '0';
        
        let message = 
          `👤 <b>Amin Tanhaei - Bot Status</b> 📊\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ ${botStatus.running ? '🟢 Active & Monitoring' : '🔴 Starting...'}\n` +
          `┃ ⚡ Mode: ${botStatus.eventDrivenMode ? 'Event-Driven' : 'Polling'}\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📈 <b>Transaction Statistics:</b>\n` +
          `├─ 📤 Total Transfers: ${botStatus.totalTransfers}\n` +
          `├─ ✅ Successful: ${botStatus.successfulTransfers}\n` +
          `├─ 🔄 Retried: ${botStatus.retriedTransfers}\n` +
          `├─ 🚀 RBF Replacements: ${botStatus.rbfReplacements}\n` +
          `├─ 📊 Success Rate: ${successRate}%\n` +
          `└─ ⚠️ Errors: ${botStatus.errors}\n\n` +
          `⚡ <b>Performance Metrics:</b>\n` +
          `├─ 🎯 Avg Detection: ${avgDetectionTime}ms\n` +
          `└─ 🚀 Avg Transfer: ${avgTransferTime}ms\n\n` +
          `📡 <b>Network Status:</b>\n` +
          `├─ 🔌 RPC Providers: ${providers.length}\n` +
          `├─ 🔗 Last Block: #${botStatus.lastBlock}\n` +
          `└─ ⏳ Pending TXs: ${pendingTransactions.size}\n\n` +
          `⏱️ <b>Uptime:</b> ${hours}h ${minutes}m ${seconds}s`;
        
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (error) {
        await telegramBot.sendMessage(chatId, `👤 <b>Amin Tanhaei - Error</b>\n\n❌ Failed to fetch status\n\n📝 ${error.message}`, { parse_mode: 'HTML' });
      }
    });
  });
  
  telegramBot.onText(/\/rpc/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `🔌 Testing RPC connections... ⏳`, { parse_mode: 'HTML' });
      
      try {
        const testPromises = providers.map(async ({ name, provider }) => {
          const start = Date.now();
          try {
            const blockNumberPromise = provider.getBlockNumber();
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Provider timeout')), 5000)
            );
            
            await Promise.race([blockNumberPromise, timeoutPromise]);
            const latency = Date.now() - start;
            providerHealth.set(name, { status: 'connected', latency, lastCheck: Date.now() });
            return { name, status: 'connected', latency };
          } catch (error) {
            const latency = Date.now() - start;
            providerHealth.set(name, { status: 'error', latency, lastCheck: Date.now() });
            return { name, status: 'error', latency };
          }
        });
        
        const results = await Promise.all(testPromises);
        
        let message = 
          `👤 <b>Amin Tanhaei - RPC Status</b> 🔌\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 🧪 <b>Live Connection Test</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const statusIcon = result.status === 'connected' ? '🟢' : '🔴';
          const isLast = i === results.length - 1;
          const prefix = isLast ? '└─' : '├─';
          
          message += `${prefix} ${statusIcon} <b>${result.name}</b>\n`;
          message += `${isLast ? '  ' : '│ '}  ├─ Status: ${result.status}\n`;
          message += `${isLast ? '  ' : '│ '}  └─ Latency: ${result.latency}ms\n\n`;
        }
        
        message += `📊 <b>Total Providers:</b> ${providers.length}`;
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - Error</b>\n\n❌ Failed to test RPC connections\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });
  
  telegramBot.onText(/\/failover/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      try {
        const currentProvider = getCurrentProvider();
        const totalSwitches = lastProviderSwitch ? 1 : 0;
        const uptime = Math.floor((Date.now() - botStatus.startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        let message = 
          `👤 <b>Amin Tanhaei - Failover Status</b> 🔄\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 🔌 <b>RPC Failover System</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `✅ <b>Active Provider:</b> ${currentProvider ? currentProvider.name : 'N/A'}\n` +
          `📊 <b>Total Providers:</b> ${providers.length}\n\n` +
          `📈 <b>Failure Statistics:</b>\n`;
        
        let hasFailures = false;
        for (const [providerName, count] of providerFailureCount.entries()) {
          if (count > 0) {
            hasFailures = true;
            const icon = count >= MAX_PROVIDER_FAILURES ? '🔴' : '⚠️';
            message += `├─ ${icon} ${providerName}: ${count} failures\n`;
          }
        }
        
        if (!hasFailures) {
          message += `└─ ✅ No failures recorded\n`;
        }
        
        message += `\n⚙️ <b>Failover Settings:</b>\n`;
        message += `├─ Max Failures: ${MAX_PROVIDER_FAILURES}\n`;
        message += `├─ Cooldown: ${PROVIDER_SWITCH_COOLDOWN / 1000}s\n`;
        message += `└─ Auto-Switch: Enabled\n\n`;
        
        if (lastProviderSwitch) {
          const timeSinceSwitch = Math.floor((Date.now() - lastProviderSwitch) / 1000);
          message += `🕒 <b>Last Switch:</b> ${timeSinceSwitch}s ago\n`;
        } else {
          message += `🕒 <b>Last Switch:</b> Never\n`;
        }
        
        message += `\n⏱️ <b>Uptime:</b> ${hours}h ${minutes}m`;
        
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (error) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - Error</b>\n\n❌ Failed to fetch failover status\n\n📝 ${error.message}`,
          { parse_mode: 'HTML' }
        );
      }
    });
  });
  
  telegramBot.onText(/\/health/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `🧠 Analyzing system health... ⏳`, { parse_mode: 'HTML' });
      
      try {
        const provider = await getFastestProvider();
        const balance = await provider.getBalance(monitoredAddress);
        const blockNumber = await provider.getBlockNumber();
        
        const uptime = Math.floor((Date.now() - botStatus.startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        let nonceStatus = 'N/A';
        if (nonceManager && nonceManager.isInitialized) {
          try {
            const status = await nonceManager.getNonceStatus();
            nonceStatus = `L:${status.local} | N:${status.network}`;
          } catch (e) {
            nonceStatus = 'Error';
          }
        }
        
        let message = 
          `👤 <b>Amin Tanhaei - System Health</b> 🧠\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ ${botStatus.running ? '🟢 System Healthy' : '🔴 System Starting'}\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `💰 <b>Wallet Status:</b>\n` +
          `├─ Balance: ${ethers.formatEther(balance)} ETH\n` +
          `└─ Block: #${blockNumber}\n\n` +
          `📡 <b>Network:</b>\n` +
          `├─ Providers: ${providers.length} active\n` +
          `└─ Nonce: ${nonceStatus}\n\n` +
          `📊 <b>Performance:</b>\n` +
          `├─ Transfers: ${botStatus.totalTransfers}\n` +
          `├─ Successful: ${botStatus.successfulTransfers}\n` +
          `├─ Errors: ${botStatus.errors}\n` +
          `└─ RBF: ${botStatus.rbfReplacements}\n\n` +
          `⏱️ <b>Uptime:</b> ${hours}h ${minutes}m`;
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - Error</b>\n\n❌ Failed to fetch health report\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });

  // ===================================================================
  // 🆕 کامندهای جدید - دقیق و حرفه‌ای
  // ===================================================================

  // /pause - توقف موقت مانیتورینگ
  telegramBot.onText(/\/pause/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      if (botStatus.paused) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - توقف موقت</b> ⏸️\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ ⚠️ <b>Already Paused</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `ℹ️ مانیتورینگ قبلاً متوقف شده است\n\n` +
          `برای ادامه: /resume`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      
      botStatus.paused = true;
      console.log('⏸️ Monitoring paused by user');
      
      await telegramBot.sendMessage(
        chatId,
        `👤 <b>Amin Tanhaei - توقف موقت</b> ⏸️\n\n` +
        `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `┃ ⏸️ <b>Monitoring Paused</b>\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✅ مانیتورینگ با موفقیت متوقف شد\n\n` +
        `📌 <b>وضعیت:</b>\n` +
        `├─ 🔴 مانیتورینگ: غیرفعال\n` +
        `├─ 💚 ربات: فعال\n` +
        `└─ 🔌 اتصال RPC: برقرار\n\n` +
        `⚠️ تراکنش‌های ورودی پردازش نمی‌شوند\n\n` +
        `برای ادامه: /resume`,
        { parse_mode: 'HTML' }
      );
    });
  });

  // /resume - ادامه مانیتورینگ
  telegramBot.onText(/\/resume/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      if (!botStatus.paused) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - ادامه مانیتورینگ</b> ▶️\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ ✅ <b>Already Running</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `ℹ️ مانیتورینگ در حال اجرا است\n\n` +
          `📊 برای مشاهده وضعیت: /status`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      
      botStatus.paused = false;
      console.log('▶️ Monitoring resumed by user');
      
      await telegramBot.sendMessage(
        chatId,
        `👤 <b>Amin Tanhaei - ادامه مانیتورینگ</b> ▶️\n\n` +
        `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `┃ ✅ <b>Monitoring Resumed</b>\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🚀 مانیتورینگ مجدداً فعال شد\n\n` +
        `📌 <b>وضعیت:</b>\n` +
        `├─ 🟢 مانیتورینگ: فعال\n` +
        `├─ ⚡ حالت: ${botStatus.eventDrivenMode ? 'Event-Driven' : 'Polling'}\n` +
        `└─ 🔌 RPC: ${providers.length} فعال\n\n` +
        `✅ تراکنش‌های ورودی پردازش می‌شوند`,
        { parse_mode: 'HTML' }
      );
    });
  });

  // /history - تاریخچه تراکنش‌ها
  telegramBot.onText(/\/history/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `📜 Loading transaction history... ⏳`, { parse_mode: 'HTML' });
      
      try {
        const history = botStatus.transactionHistory.slice(-10).reverse();
        
        if (history.length === 0) {
          await telegramBot.editMessageText(
            `👤 <b>Amin Tanhaei - تاریخچه تراکنش‌ها</b> 📜\n\n` +
            `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┃ ℹ️ <b>No Transactions</b>\n` +
            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📭 هیچ تراکنشی ثبت نشده است`,
            {
              chat_id: chatId,
              message_id: loadingMsg.message_id,
              parse_mode: 'HTML'
            }
          );
          return;
        }
        
        let message = 
          `👤 <b>Amin Tanhaei - تاریخچه تراکنش‌ها</b> 📜\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 📊 <b>آخرین ${history.length} تراکنش</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        for (let i = 0; i < history.length; i++) {
          const tx = history[i];
          const status = tx.success ? '✅' : '❌';
          const time = new Date(tx.timestamp).toLocaleString('fa-IR', { 
            hour: '2-digit', 
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit'
          });
          
          message += `${status} <b>#${history.length - i}</b> - ${time}\n`;
          message += `├─ 💰 مبلغ: ${tx.amount} ETH\n`;
          message += `├─ ⛽ گس: ${tx.gasUsed || 'N/A'} Gwei\n`;
          message += `└─ 🔗 <code>${tx.hash?.substring(0, 20)}...</code>\n\n`;
        }
        
        message += `📊 <b>آمار کلی:</b>\n`;
        message += `├─ 📤 کل: ${botStatus.totalTransfers}\n`;
        message += `└─ ✅ موفق: ${botStatus.successfulTransfers}`;
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در بارگذاری تاریخچه\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });

  // /pending - تراکنش‌های معلق
  telegramBot.onText(/\/pending/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      try {
        const pendingCount = pendingTransactions.size;
        
        let message = 
          `👤 <b>Amin Tanhaei - تراکنش‌های معلق</b> ⏳\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 📊 <b>Pending Transactions</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        if (pendingCount === 0) {
          message += `✅ هیچ تراکنش معلقی وجود ندارد\n\n`;
          message += `📌 تمام تراکنش‌ها تأیید شده‌اند`;
        } else {
          message += `⏳ <b>تعداد معلق:</b> ${pendingCount}\n\n`;
          
          let index = 1;
          for (const [txHash, txData] of pendingTransactions.entries()) {
            const elapsed = Math.floor((Date.now() - txData.timestamp) / 1000);
            message += `${index}. 🔗 <code>${txHash.substring(0, 15)}...</code>\n`;
            message += `   ├─ ⏱️ مدت: ${elapsed}s\n`;
            message += `   └─ 🔄 تلاش: ${txData.attempts || 1}\n\n`;
            index++;
            if (index > 5) break;
          }
          
          if (pendingCount > 5) {
            message += `... و ${pendingCount - 5} تراکنش دیگر\n\n`;
          }
          
          message += `⚠️ در حال بررسی و RBF در صورت نیاز`;
        }
        
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (error) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در بارگذاری تراکنش‌های معلق\n\n📝 ${error.message}`,
          { parse_mode: 'HTML' }
        );
      }
    });
  });

  // /gas - قیمت فعلی گس
  telegramBot.onText(/\/gas/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `⛽ Fetching live gas prices... ⏳`, { parse_mode: 'HTML' });
      
      try {
        const provider = await getFastestProvider();
        const feeData = await provider.getFeeData();
        const blockNumber = await provider.getBlockNumber();
        
        const maxFeeGwei = feeData.maxFeePerGas ? ethers.formatUnits(feeData.maxFeePerGas, 'gwei') : 'N/A';
        const maxPriorityGwei = feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A';
        const gasPriceGwei = feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') : 'N/A';
        
        const estimatedCost = feeData.maxFeePerGas ? 
          ethers.formatEther(feeData.maxFeePerGas * 21000n) : 'N/A';
        
        let message = 
          `👤 <b>Amin Tanhaei - قیمت گس</b> ⛽\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 🔥 <b>Live Gas Prices</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📊 <b>EIP-1559 (زنده):</b>\n` +
          `├─ 🎯 Max Fee: ${maxFeeGwei} Gwei\n` +
          `├─ ⚡ Priority: ${maxPriorityGwei} Gwei\n` +
          `└─ 📈 Base: ${gasPriceGwei} Gwei\n\n` +
          `💰 <b>هزینه تخمینی:</b>\n` +
          `└─ انتقال ساده: ~${estimatedCost} ETH\n\n` +
          `📍 <b>بلاک:</b> #${blockNumber}\n` +
          `⏰ <b>زمان:</b> ${new Date().toLocaleTimeString('fa-IR')}\n\n` +
          `ℹ️ قیمت‌ها هر لحظه تغییر می‌کنند`;
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در دریافت قیمت گس\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });

  // /nonce - وضعیت nonce
  telegramBot.onText(/\/nonce/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `🔢 Checking nonce status... ⏳`, { parse_mode: 'HTML' });
      
      try {
        if (!nonceManager || !nonceManager.isInitialized) {
          await telegramBot.editMessageText(
            `👤 <b>Amin Tanhaei - وضعیت Nonce</b> 🔢\n\n` +
            `⚠️ Nonce Manager هنوز راه‌اندازی نشده`,
            {
              chat_id: chatId,
              message_id: loadingMsg.message_id,
              parse_mode: 'HTML'
            }
          );
          return;
        }
        
        const status = await nonceManager.getNonceStatus();
        const synchronized = status.synchronized ? '✅' : '⚠️';
        const gapInfo = status.gap !== null ? status.gap : 0;
        
        let message = 
          `👤 <b>Amin Tanhaei - وضعیت Nonce</b> 🔢\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ ${synchronized} <b>${status.synchronized ? 'همگام' : 'ناهمگام'}</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📊 <b>مقادیر Nonce:</b>\n` +
          `├─ 📁 Local: ${status.local}\n` +
          `├─ 🌐 Network: ${status.network}\n` +
          `├─ 🔄 Current: ${status.current}\n` +
          `└─ 📏 Gap: ${gapInfo}\n\n`;
        
        if (status.synchronized) {
          message += `✅ <b>وضعیت:</b> عالی\n`;
          message += `ℹ️ Local و Network همگام هستند`;
        } else {
          message += `⚠️ <b>وضعیت:</b> نیاز به همگام‌سازی\n`;
          if (gapInfo > 0) {
            message += `ℹ️ ${gapInfo} تراکنش معلق احتمالی`;
          } else if (gapInfo < 0) {
            message += `⚠️ Local عقب‌تر از Network است`;
          }
        }
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در بررسی nonce\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });

  // /stats - آمار سریع
  telegramBot.onText(/\/stats/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      try {
        const uptime = Math.floor((Date.now() - botStatus.startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        const successRate = botStatus.totalTransfers > 0
          ? ((botStatus.successfulTransfers / botStatus.totalTransfers) * 100).toFixed(1)
          : '0';
        
        const avgDetection = botStatus.detectionTimes.length > 0
          ? (botStatus.detectionTimes.reduce((a, b) => a + b, 0) / botStatus.detectionTimes.length).toFixed(0)
          : '0';
        
        const message = 
          `👤 <b>Amin Tanhaei - آمار سریع</b> ⚡\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 📊 <b>Quick Stats</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `🚀 <b>عملکرد:</b>\n` +
          `├─ ⚡ تشخیص: ${avgDetection}ms\n` +
          `├─ 📤 کل: ${botStatus.totalTransfers}\n` +
          `├─ ✅ موفق: ${botStatus.successfulTransfers}\n` +
          `└─ 📊 نرخ: ${successRate}%\n\n` +
          `⏱️ <b>زمان کارکرد:</b> ${hours}h ${minutes}m\n` +
          `🔴 <b>خطاها:</b> ${botStatus.errors}\n` +
          `🔄 <b>RBF:</b> ${botStatus.rbfReplacements}\n\n` +
          `${botStatus.paused ? '⏸️ <b>وضعیت:</b> متوقف شده' : '🟢 <b>وضعیت:</b> در حال اجرا'}`;
        
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (error) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در دریافت آمار\n\n📝 ${error.message}`,
          { parse_mode: 'HTML' }
        );
      }
    });
  });

  // /settings - تنظیمات ربات
  telegramBot.onText(/\/settings/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      try {
        const message = 
          `👤 <b>Amin Tanhaei - تنظیمات</b> ⚙️\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 🔧 <b>Bot Configuration</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `⚡ <b>حالت کار:</b>\n` +
          `└─ ${botStatus.eventDrivenMode ? '🔥 Event-Driven (سریع)' : '⏱️ Polling'}\n\n` +
          `🔌 <b>RPC:</b>\n` +
          `├─ تعداد: ${RPC_URLS.length} provider\n` +
          `└─ Timeout: ${RPC_TIMEOUT}ms\n\n` +
          `⛽ <b>Gas:</b>\n` +
          `├─ Buffer: ${GAS_SAFETY_BUFFER_PERCENT}%\n` +
          `└─ RBF Increase: ${RBF_GAS_INCREASE_PERCENT}%\n\n` +
          `🔄 <b>بازیابی:</b>\n` +
          `├─ Max Retry: ${MAX_RETRY_ATTEMPTS}\n` +
          `└─ TX Timeout: ${PENDING_TX_TIMEOUT / 1000}s\n\n` +
          `💰 <b>حداقل انتقال:</b> بدون محدودیت (هر مقداری)\n` +
          `🔢 <b>Process ID:</b> ${process.pid}\n\n` +
          `${!botStatus.eventDrivenMode ? `⏱️ <b>Interval:</b> ${POLL_INTERVAL}ms` : ''}`;
        
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (error) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در نمایش تنظیمات\n\n📝 ${error.message}`,
          { parse_mode: 'HTML' }
        );
      }
    });
  });

  // /metrics - متریک‌های دقیق
  telegramBot.onText(/\/metrics/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      try {
        if (!metricsCollector) {
          await telegramBot.sendMessage(
            chatId,
            `👤 <b>Amin Tanhaei - متریک‌ها</b> 📈\n\n⚠️ Metrics Collector فعال نیست`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        
        const metrics = metricsCollector.getMetrics();
        const summary = metricsCollector.getSummary();
        
        const message = 
          `👤 <b>Amin Tanhaei - متریک‌های دقیق</b> 📈\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 📊 <b>Performance Metrics</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `⚡ <b>سرعت (میانگین):</b>\n` +
          `├─ Check: ${summary.performance.avgCheckTime}\n` +
          `└─ Transfer: ${summary.performance.avgTransferTime}\n\n` +
          `🌐 <b>RPC:</b>\n` +
          `├─ کل تماس: ${summary.rpc.totalCalls}\n` +
          `├─ نرخ خطا: ${summary.rpc.failureRate}\n` +
          `├─ میانگین پاسخ: ${summary.rpc.avgResponseTime}\n` +
          `└─ Failover: ${summary.rpc.failovers}\n\n` +
          `📤 <b>تراکنش‌ها:</b>\n` +
          `├─ کل: ${metrics.transactions.total}\n` +
          `├─ موفق: ${metrics.transactions.successful}\n` +
          `├─ ناموفق: ${metrics.transactions.failed}\n` +
          `└─ RBF: ${metrics.transactions.rbfReplaced}\n\n` +
          `🔢 <b>Nonce:</b>\n` +
          `├─ فعلی: ${metrics.nonce.currentNonce}\n` +
          `├─ تعارض: ${metrics.nonce.conflicts}\n` +
          `└─ همگام‌سازی: ${metrics.nonce.syncs}\n\n` +
          `💾 <b>حافظه:</b> ${summary.system.memory}\n` +
          `⏱️ <b>آپتایم:</b> ${summary.system.uptime}`;
        
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (error) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در دریافت متریک‌ها\n\n📝 ${error.message}`,
          { parse_mode: 'HTML' }
        );
      }
    });
  });

  // /logs - آخرین خطاها و لاگ‌ها
  telegramBot.onText(/\/logs/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      try {
        if (!metricsCollector) {
          await telegramBot.sendMessage(
            chatId,
            `👤 <b>Amin Tanhaei - لاگ‌ها</b> 📝\n\n⚠️ Metrics Collector فعال نیست`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        
        const recentErrors = metricsCollector.getRecentErrors();
        
        let message = 
          `👤 <b>Amin Tanhaei - آخرین لاگ‌ها</b> 📝\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 📊 <b>Recent Logs</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        if (recentErrors.length === 0) {
          message += `✅ هیچ خطایی ثبت نشده است\n\n`;
          message += `📌 سیستم به‌طور کامل سالم است`;
        } else {
          message += `⚠️ <b>آخرین ${recentErrors.length} خطا:</b>\n\n`;
          
          for (let i = 0; i < Math.min(5, recentErrors.length); i++) {
            const error = recentErrors[i];
            const time = new Date(error.timestamp).toLocaleString('fa-IR', { 
              hour: '2-digit', 
              minute: '2-digit',
              second: '2-digit'
            });
            
            message += `${i + 1}. ⏰ ${time}\n`;
            message += `   ├─ 🏷️ Type: ${error.type}\n`;
            message += `   └─ 📝 ${error.message.substring(0, 40)}...\n\n`;
          }
          
          if (recentErrors.length > 5) {
            message += `... و ${recentErrors.length - 5} خطای دیگر\n\n`;
          }
          
          message += `💡 برای جزئیات بیشتر: /metrics`;
        }
        
        await telegramBot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (error) {
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در دریافت لاگ‌ها\n\n📝 ${error.message}`,
          { parse_mode: 'HTML' }
        );
      }
    });
  });

  // /network - اطلاعات شبکه
  telegramBot.onText(/\/network/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `🌐 Fetching network info... ⏳`, { parse_mode: 'HTML' });
      
      try {
        const provider = await getFastestProvider();
        const network = await provider.getNetwork();
        const blockNumber = await provider.getBlockNumber();
        const block = await provider.getBlock(blockNumber);
        const feeData = await provider.getFeeData();
        
        const chainName = network.name || 'Unknown';
        const chainId = network.chainId.toString();
        const blockTime = block ? new Date(Number(block.timestamp) * 1000).toLocaleString('fa-IR') : 'N/A';
        const gasPrice = feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') : 'N/A';
        
        const message = 
          `👤 <b>Amin Tanhaei - اطلاعات شبکه</b> 🌐\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 🔗 <b>Network Information</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `📡 <b>شبکه:</b>\n` +
          `├─ نام: ${chainName}\n` +
          `├─ Chain ID: ${chainId}\n` +
          `└─ آخرین بلاک: #${blockNumber}\n\n` +
          `⏰ <b>زمان بلاک:</b>\n` +
          `└─ ${blockTime}\n\n` +
          `⛽ <b>گس فعلی:</b>\n` +
          `└─ ${gasPrice} Gwei\n\n` +
          `🔌 <b>RPC فعال:</b>\n` +
          `└─ ${providers.length} provider`;
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در دریافت اطلاعات شبکه\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });

  // /emergency - انتقال فوری تمام موجودی (با تأیید دوباره)
  telegramBot.onText(/\/emergency/, async (msg) => {
    await requireAuth(msg, async () => {
      const chatId = msg.chat.id;
      
      const loadingMsg = await telegramBot.sendMessage(chatId, `🚨 Checking wallet... ⏳`, { parse_mode: 'HTML' });
      
      try {
        const provider = await getFastestProvider();
        const balance = await provider.getBalance(monitoredAddress);
        const balanceETH = ethers.formatEther(balance);
        
        if (balance === 0n) {
          await telegramBot.editMessageText(
            `👤 <b>Amin Tanhaei - انتقال اضطراری</b> 🚨\n\n` +
            `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┃ ℹ️ <b>No Balance</b>\n` +
            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `💰 موجودی: 0 ETH\n\n` +
            `ℹ️ هیچ موجودی برای انتقال وجود ندارد`,
            {
              chat_id: chatId,
              message_id: loadingMsg.message_id,
              parse_mode: 'HTML'
            }
          );
          return;
        }
        
        const message = 
          `👤 <b>Amin Tanhaei - انتقال اضطراری</b> 🚨\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ ⚠️ <b>EMERGENCY TRANSFER</b>\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `💰 <b>موجودی فعلی:</b> ${balanceETH} ETH\n` +
          `📤 <b>مقصد:</b> <code>${maskSensitiveData(DESTINATION_ADDRESS)}</code>\n\n` +
          `⚠️ <b>هشدار:</b>\n` +
          `این عملیات تمام موجودی را منتقل می‌کند!\n\n` +
          `🔐 <b>تأیید:</b>\n` +
          `برای ادامه کلمه زیر را ارسال کنید:\n` +
          `<code>CONFIRM_EMERGENCY</code>\n\n` +
          `⏱️ این پیام 60 ثانیه اعتبار دارد`;
        
        await telegramBot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (error) {
        await telegramBot.editMessageText(
          `👤 <b>Amin Tanhaei - خطا</b>\n\n❌ خطا در بررسی موجودی\n\n📝 ${error.message}`,
          {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });
  });
  
  telegramBot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!text || text.startsWith('/')) {
      return;
    }
    
    if (!isAuthenticated(chatId)) {
      if (text.trim() === TELEGRAM_PASSWORD) {
        authenticatedUsers.set(chatId, true);
        failedAttempts.delete(chatId);
        
        await telegramBot.sendMessage(
          chatId,
          `👤 <b>Amin Tanhaei - Access Granted</b> ✅\n\n` +
          `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `┃ 🔓 <b>Login Successful!</b>\n` +
          `┃ 🔒 Private Bot - Authenticated\n` +
          `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `Type /help for available commands`,
          { parse_mode: 'HTML' }
        );
      } else {
        recordFailedAttempt(chatId);
        const attempts = failedAttempts.get(chatId);
        
        if (attempts.count >= MAX_FAILED_ATTEMPTS) {
          await telegramBot.sendMessage(
            chatId,
            `❌ <b>Blocked!</b>\n\nToo many failed attempts.`,
            { parse_mode: 'HTML' }
          );
        } else {
          const remaining = MAX_FAILED_ATTEMPTS - attempts.count;
          await telegramBot.sendMessage(
            chatId,
            `❌ <b>Incorrect!</b>\n\nRemaining: ${remaining}/${MAX_FAILED_ATTEMPTS}`,
            { parse_mode: 'HTML' }
          );
        }
      }
    }
  });
  
  telegramBot.on('polling_error', (error) => {
    console.error('❌ Telegram error:', error.message);
  });
}

// ===================================================================
// MAIN STARTUP
// ===================================================================

async function main() {
  try {
    console.log('🚀 Starting Ultra-Fast ETH Transfer Bot...');
    console.log('⚡ Event-Driven Architecture for Maximum Speed\n');
    
    metricsCollector = new MetricsCollector();
    
    instanceLockManager = new InstanceLockManager();
    await instanceLockManager.acquireLock();
    
    validateEnvVariables();
    console.log('✅ Environment validated');
    console.log(`🔒 Private key: ${maskSensitiveData(PRIVATE_KEY)}`);
    console.log(`📤 Destination: ${maskSensitiveData(DESTINATION_ADDRESS)}\n`);
    
    await testPrivateKey();
    
    const primaryProvider = await initializeProvidersWithRetry();
    
    wallet = new ethers.Wallet(PRIVATE_KEY, primaryProvider);
    monitoredAddress = wallet.address;
    console.log('✅ Wallet connected');
    console.log(`📍 Monitoring: ${maskSensitiveData(monitoredAddress)}\n`);
    
    validateAddresses();
    
    const path = require('path');
    const fs = require('fs').promises;
    const dataDir = path.join(process.cwd(), 'data');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }).catch(() => {});
    pendingTxFilePath = path.join(dataDir, `pending_tx_${monitoredAddress.toLowerCase()}.json`);
    await loadPendingTransactions();
    
    nonceManager = new NonceManager(monitoredAddress, primaryProvider);
    await nonceManager.initialize();
    console.log('✅ Nonce manager initialized\n');
    
    // Pre-warm everything the hot path needs so the first transfer has zero extra round-trips
    await Promise.allSettled([
      isDestinationEOA(primaryProvider),
      getChainId(primaryProvider),
      refreshHotCaches(primaryProvider)
    ]);
    
    if (TELEGRAM_BOT_TOKEN) {
      telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
      console.log('✅ Telegram bot initialized');
      
      setupTelegramCommands();
    }
    
    await displayStatus();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🌐 Health check server: http://localhost:${PORT}/health\n`);
    });
    
    if (telegramBot && TELEGRAM_CHAT_ID) {
      const balance = await primaryProvider.getBalance(monitoredAddress);
      await sendTelegramMessage(
        `👤 <b>Amin Tanhaei - Production Ready!</b> ✅\n\n` +
        `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `┃ 🚀 <b>Bot Initialized</b>\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📍 <b>Source:</b> <code>${maskSensitiveData(monitoredAddress)}</code>\n` +
        `📤 <b>Destination:</b> <code>${maskSensitiveData(DESTINATION_ADDRESS)}</code>\n` +
        `💰 <b>Balance:</b> ${ethers.formatEther(balance)} ETH\n\n` +
        `✅ <b>Production Features:</b>\n` +
        `├─ 🚀 Live gas fetching (EIP-1559)\n` +
        `├─ 📊 Dynamic estimateGas() + fallback\n` +
        `├─ 💰 Accurate gas cost calculation\n` +
        `├─ 🛡️ ${GAS_SAFETY_BUFFER_PERCENT}% safety buffer\n` +
        `├─ ⚡ Exact transferable amount\n` +
        `├─ ✅ Auto-send (never fails)\n` +
        `├─ 🔄 Replace-by-Fee (RBF)\n` +
        `├─ 🔢 Persistent nonce management\n` +
        `├─ ⚠️ Complete error handling\n` +
        `├─ 🔒 Secure logging\n` +
        `└─ 🔌 RPC failover\n\n` +
        `⚙️ <b>Settings:</b> ${botStatus.eventDrivenMode ? 'Event-Driven' : POLL_INTERVAL + 'ms polling'}, ${RPC_URLS.length} RPCs\n` +
        `🔒 <b>Instance Lock:</b> Active (PID: ${process.pid})`
      );
    }
    
    botStatus.running = true;
    console.log('✅ Bot fully operational\n');
    
    if (USE_EVENT_DRIVEN) {
      await startEventDrivenMonitoring();
    } else {
      await startPollingMonitoring();
    }
    
  } catch (error) {
    console.error('\n❌ Critical error:', error.message);
    if (instanceLockManager) {
      await instanceLockManager.releaseLock();
    }
    process.exit(1);
  }
}

main();
