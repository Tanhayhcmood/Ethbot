/**
 * Integration Module - Connects Auto Fee Switcher to Existing Bot
 * 
 * This module provides a clean integration point for the auto fee
 * token switching feature without modifying any existing code.
 * 
 * Usage:
 * 1. Import this module in your startup script
 * 2. Call initializeAutoFeeSwitcher() after bot is running
 * 3. The switcher will automatically detect and handle token deposits
 * 
 * This module is an EXTENSION - does NOT modify existing code
 */

const AutoFeeTokenSwitcher = require('./auto_fee_token');
const DepositListener = require('./deposit_listener');
const ERC20Executor = require('./erc20_executor');
const tokenRegistry = require('./token_registry');

let autoFeeSwitcherInstance = null;

async function initializeAutoFeeSwitcher(config) {
  console.log('\n🔧 Initializing Auto Fee Token Switcher Integration...');
  
  const requiredFields = ['privateKey', 'destinationAddress', 'provider', 'monitoredAddress'];
  for (const field of requiredFields) {
    if (!config[field]) {
      throw new Error(`Missing required config: ${field}`);
    }
  }
  
  try {
    autoFeeSwitcherInstance = new AutoFeeTokenSwitcher({
      privateKey: config.privateKey,
      destinationAddress: config.destinationAddress,
      provider: config.provider,
      monitoredAddress: config.monitoredAddress,
      telegramNotifier: config.telegramNotifier || null
    });
    
    await autoFeeSwitcherInstance.start();
    
    console.log('✅ Auto Fee Token Switcher integrated successfully!\n');
    
    return autoFeeSwitcherInstance;
    
  } catch (error) {
    console.error('❌ Failed to initialize Auto Fee Switcher:', error.message);
    throw error;
  }
}

async function stopAutoFeeSwitcher() {
  if (autoFeeSwitcherInstance) {
    await autoFeeSwitcherInstance.stop();
    autoFeeSwitcherInstance = null;
    console.log('✅ Auto Fee Switcher stopped');
  }
}

function getAutoFeeSwitcherStatus() {
  if (!autoFeeSwitcherInstance) {
    return { running: false, message: 'Not initialized' };
  }
  return autoFeeSwitcherInstance.getStatus();
}

function getAutoFeeSwitcherMetrics() {
  if (!autoFeeSwitcherInstance) {
    return null;
  }
  return autoFeeSwitcherInstance.getMetrics();
}

function getSupportedTokens() {
  return Object.keys(tokenRegistry.SUPPORTED_TOKENS);
}

function getTokenInfo(symbol) {
  return tokenRegistry.getTokenBySymbol(symbol);
}

module.exports = {
  initializeAutoFeeSwitcher,
  stopAutoFeeSwitcher,
  getAutoFeeSwitcherStatus,
  getAutoFeeSwitcherMetrics,
  getSupportedTokens,
  getTokenInfo,
  AutoFeeTokenSwitcher,
  DepositListener,
  ERC20Executor,
  tokenRegistry
};
