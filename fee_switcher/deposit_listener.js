/**
 * Deposit Listener - Multi-Token Deposit Detection
 * 
 * Monitors incoming deposits for:
 * - ETH (Native transfers)
 * - USDT (ERC20 Transfer events)
 * - USDC (ERC20 Transfer events)
 * 
 * Detection speed: < 1 second (event-driven)
 * 
 * This module is an EXTENSION - does NOT modify existing code
 */

const { ethers } = require('ethers');
const {
  SUPPORTED_TOKENS,
  ERC20_ABI,
  ERC20_TRANSFER_EVENT_SIGNATURE,
  getTokenByAddress,
  formatTokenAmount
} = require('./token_registry');

class DepositListener {
  constructor(provider, monitoredAddress, options = {}) {
    this.provider = provider;
    this.monitoredAddress = monitoredAddress.toLowerCase();
    
    this.options = {
      enableETH: options.enableETH !== false,
      enableUSDT: options.enableUSDT !== false,
      enableUSDC: options.enableUSDC !== false,
      logPrefix: options.logPrefix || '🔍 [DepositListener]',
      ...options
    };
    
    this.isListening = false;
    this.eventFilters = [];
    this.tokenContracts = new Map();
    this.lastETHBalance = 0n;
    this.lastProcessedBlock = 0;
    this.isProcessingETH = false;
    this.processedETHBlocks = new Set();
    this.processedERC20TxHashes = new Set();
    this.isFirstBlockAfterStart = true;
    this.pendingTransfer = false;
    
    this.callbacks = {
      onDeposit: null,
      onError: null
    };
    
    this.metrics = {
      totalDepositsDetected: 0,
      ethDeposits: 0,
      usdtDeposits: 0,
      usdcDeposits: 0,
      errors: 0,
      startTime: null,
      lastDepositTime: null
    };
    
    this.blockListener = null;
    this.transferListeners = new Map();
  }
  
  async start(onDeposit, onError = null) {
    if (this.isListening) {
      console.log(`${this.options.logPrefix} Already listening for deposits`);
      return;
    }
    
    this.callbacks.onDeposit = onDeposit;
    this.callbacks.onError = onError;
    this.metrics.startTime = Date.now();
    
    console.log(`\n${this.options.logPrefix} ========================================`);
    console.log(`${this.options.logPrefix} 🚀 Starting Multi-Token Deposit Listener`);
    console.log(`${this.options.logPrefix} 📍 Monitored Address: ${this.maskAddress(this.monitoredAddress)}`);
    console.log(`${this.options.logPrefix} ========================================`);
    
    try {
      await this.initializeTokenContracts();
      await this.setupEventListeners();
      
      this.isListening = true;
      
      console.log(`${this.options.logPrefix} ✅ Deposit listener active`);
      console.log(`${this.options.logPrefix} 👀 Monitoring: ETH, USDT, USDC`);
      console.log(`${this.options.logPrefix} ⚡ Detection speed: < 1 second\n`);
      
    } catch (error) {
      console.error(`${this.options.logPrefix} ❌ Failed to start:`, error.message);
      this.metrics.errors++;
      if (this.callbacks.onError) {
        this.callbacks.onError(error, 'start');
      }
      throw error;
    }
  }
  
  async stop() {
    if (!this.isListening) return;
    
    console.log(`${this.options.logPrefix} 🛑 Stopping deposit listener...`);
    
    if (this.blockListener) {
      this.provider.off('block', this.blockListener);
      this.blockListener = null;
    }
    
    for (const [symbol, listener] of this.transferListeners.entries()) {
      const token = SUPPORTED_TOKENS[symbol];
      if (token && token.contractAddress) {
        const contract = this.tokenContracts.get(symbol);
        if (contract) {
          contract.off('Transfer', listener);
        }
      }
    }
    this.transferListeners.clear();
    
    this.isListening = false;
    console.log(`${this.options.logPrefix} ✅ Deposit listener stopped`);
    this.logStats();
  }
  
  async initializeTokenContracts() {
    console.log(`${this.options.logPrefix} 📝 Initializing token contracts...`);
    
    for (const [symbol, token] of Object.entries(SUPPORTED_TOKENS)) {
      if (token.isNative) continue;
      
      try {
        const contract = new ethers.Contract(
          token.contractAddress,
          ERC20_ABI,
          this.provider
        );
        
        this.tokenContracts.set(symbol, contract);
        console.log(`${this.options.logPrefix} ✅ ${symbol} contract initialized: ${this.maskAddress(token.contractAddress)}`);
        
      } catch (error) {
        console.error(`${this.options.logPrefix} ⚠️ Failed to initialize ${symbol}:`, error.message);
      }
    }
  }
  
  async setupEventListeners() {
    console.log(`${this.options.logPrefix} 🔌 Setting up event listeners...`);
    
    if (this.options.enableETH) {
      await this.setupETHListener();
    }
    
    if (this.options.enableUSDT) {
      await this.setupERC20Listener('USDT');
    }
    
    if (this.options.enableUSDC) {
      await this.setupERC20Listener('USDC');
    }
  }
  
  async setupETHListener() {
    try {
      this.lastETHBalance = await this.provider.getBalance(this.monitoredAddress);
      this.lastProcessedBlock = await this.provider.getBlockNumber();
      this.isFirstBlockAfterStart = true;
      
      console.log(`${this.options.logPrefix} 📊 Initial ETH balance: ${ethers.formatEther(this.lastETHBalance)} ETH`);
      console.log(`${this.options.logPrefix} 📦 Starting from block: #${this.lastProcessedBlock}`);
      
      this.blockListener = async (blockNumber) => {
        if (!this.isListening) return;
        
        if (blockNumber <= this.lastProcessedBlock) return;
        
        if (this.processedETHBlocks.has(blockNumber)) return;
        
        if (this.isProcessingETH) return;
        
        this.isProcessingETH = true;
        this.processedETHBlocks.add(blockNumber);
        
        if (this.processedETHBlocks.size > 100) {
          const oldest = Math.min(...this.processedETHBlocks);
          this.processedETHBlocks.delete(oldest);
        }
        
        try {
          const currentBalance = await this.provider.getBalance(this.monitoredAddress);
          const previousBalance = this.lastETHBalance;
          
          this.lastProcessedBlock = blockNumber;
          
          if (this.isFirstBlockAfterStart) {
            this.isFirstBlockAfterStart = false;
            this.lastETHBalance = currentBalance;
            return;
          }
          
          if (currentBalance > previousBalance) {
            const depositAmount = currentBalance - previousBalance;
            
            const MIN_ETH_THRESHOLD = ethers.parseEther('0.0001');
            if (depositAmount < MIN_ETH_THRESHOLD) {
              this.lastETHBalance = currentBalance;
              return;
            }
            
            console.log(`\n${this.options.logPrefix} 🔔 ETH DEPOSIT DETECTED!`);
            console.log(`${this.options.logPrefix} 💰 Amount: ${ethers.formatEther(depositAmount)} ETH`);
            console.log(`${this.options.logPrefix} 📦 Block: #${blockNumber}`);
            
            this.metrics.totalDepositsDetected++;
            this.metrics.ethDeposits++;
            this.metrics.lastDepositTime = Date.now();
            
            if (this.pendingTransfer) {
              console.log(`${this.options.logPrefix} ⏳ Skipping - transfer in progress`);
              this.lastETHBalance = currentBalance;
              return;
            }
            
            this.pendingTransfer = true;
            this.lastETHBalance = currentBalance;
            
            try {
              await this.notifyDeposit({
                token: 'ETH',
                tokenInfo: SUPPORTED_TOKENS.ETH,
                amount: depositAmount,
                formattedAmount: ethers.formatEther(depositAmount),
                blockNumber,
                timestamp: Date.now(),
                isNative: true
              });
            } finally {
              this.pendingTransfer = false;
              this.lastETHBalance = await this.provider.getBalance(this.monitoredAddress);
            }
          } else {
            this.lastETHBalance = currentBalance;
          }
          
        } catch (error) {
          this.metrics.errors++;
          if (this.callbacks.onError) {
            this.callbacks.onError(error, 'eth_balance_check');
          }
        } finally {
          this.isProcessingETH = false;
        }
      };
      
      this.provider.on('block', this.blockListener);
      console.log(`${this.options.logPrefix} ✅ ETH listener registered (block-based with debounce)`);
      
    } catch (error) {
      console.error(`${this.options.logPrefix} ❌ Failed to setup ETH listener:`, error.message);
      throw error;
    }
  }
  
  async setupERC20Listener(symbol) {
    const contract = this.tokenContracts.get(symbol);
    const token = SUPPORTED_TOKENS[symbol];
    
    if (!contract || !token) {
      console.log(`${this.options.logPrefix} ⚠️ Cannot setup listener for ${symbol}: contract not found`);
      return;
    }
    
    try {
      const filter = contract.filters.Transfer(null, this.monitoredAddress);
      
      const listener = async (from, to, value, event) => {
        if (!this.isListening) return;
        
        try {
          const txHash = event.transactionHash || event.log?.transactionHash;
          if (txHash && this.processedERC20TxHashes.has(txHash)) {
            console.log(`${this.options.logPrefix} ⏭️ Skipping duplicate TX: ${txHash.substring(0, 10)}...`);
            return;
          }
          
          if (txHash) {
            this.processedERC20TxHashes.add(txHash);
            if (this.processedERC20TxHashes.size > 1000) {
              const iterator = this.processedERC20TxHashes.values();
              this.processedERC20TxHashes.delete(iterator.next().value);
            }
          }
          
          const formattedAmount = formatTokenAmount(value, token.decimals);
          
          console.log(`\n${this.options.logPrefix} 🔔 ${symbol} DEPOSIT DETECTED!`);
          console.log(`${this.options.logPrefix} 💰 Amount: ${formattedAmount} ${symbol}`);
          console.log(`${this.options.logPrefix} 📤 From: ${this.maskAddress(from)}`);
          console.log(`${this.options.logPrefix} 🔗 TX: ${txHash ? txHash.substring(0, 10) + '...' : 'pending'}`);
          
          this.metrics.totalDepositsDetected++;
          if (symbol === 'USDT') this.metrics.usdtDeposits++;
          if (symbol === 'USDC') this.metrics.usdcDeposits++;
          this.metrics.lastDepositTime = Date.now();
          
          await this.notifyDeposit({
            token: symbol,
            tokenInfo: token,
            amount: value,
            formattedAmount,
            from,
            to,
            transactionHash: txHash || null,
            blockNumber: event.blockNumber || null,
            timestamp: Date.now(),
            isNative: false,
            contractAddress: token.contractAddress
          });
          
        } catch (error) {
          this.metrics.errors++;
          console.error(`${this.options.logPrefix} ❌ Error processing ${symbol} transfer:`, error.message);
          if (this.callbacks.onError) {
            this.callbacks.onError(error, `${symbol.toLowerCase()}_transfer`);
          }
        }
      };
      
      contract.on(filter, listener);
      this.transferListeners.set(symbol, listener);
      
      console.log(`${this.options.logPrefix} ✅ ${symbol} listener registered (Transfer events)`);
      
    } catch (error) {
      console.error(`${this.options.logPrefix} ❌ Failed to setup ${symbol} listener:`, error.message);
    }
  }
  
  async notifyDeposit(depositInfo) {
    console.log(`${this.options.logPrefix} 📢 Detected deposit: ${depositInfo.token}, switching network fee token → ${depositInfo.token}`);
    
    if (this.callbacks.onDeposit) {
      try {
        await this.callbacks.onDeposit(depositInfo);
      } catch (error) {
        console.error(`${this.options.logPrefix} ❌ Callback error:`, error.message);
        this.metrics.errors++;
      }
    }
  }
  
  async getTokenBalance(symbol) {
    if (symbol === 'ETH') {
      return await this.provider.getBalance(this.monitoredAddress);
    }
    
    const contract = this.tokenContracts.get(symbol);
    if (!contract) {
      throw new Error(`Unknown token: ${symbol}`);
    }
    
    return await contract.balanceOf(this.monitoredAddress);
  }
  
  async getAllBalances() {
    const balances = {};
    
    for (const [symbol, token] of Object.entries(SUPPORTED_TOKENS)) {
      try {
        const balance = await this.getTokenBalance(symbol);
        balances[symbol] = {
          raw: balance,
          formatted: token.isNative 
            ? ethers.formatEther(balance)
            : formatTokenAmount(balance, token.decimals)
        };
      } catch (error) {
        balances[symbol] = { error: error.message };
      }
    }
    
    return balances;
  }
  
  getMetrics() {
    const uptime = this.metrics.startTime ? Date.now() - this.metrics.startTime : 0;
    
    return {
      ...this.metrics,
      uptime,
      isListening: this.isListening,
      tokensMonitored: ['ETH', 'USDT', 'USDC'].filter(t => 
        (t === 'ETH' && this.options.enableETH) ||
        (t === 'USDT' && this.options.enableUSDT) ||
        (t === 'USDC' && this.options.enableUSDC)
      )
    };
  }
  
  logStats() {
    const stats = this.getMetrics();
    
    console.log(`\n${this.options.logPrefix} 📊 Deposit Listener Statistics:`);
    console.log(`${this.options.logPrefix} ├─ Total deposits detected: ${stats.totalDepositsDetected}`);
    console.log(`${this.options.logPrefix} ├─ ETH deposits: ${stats.ethDeposits}`);
    console.log(`${this.options.logPrefix} ├─ USDT deposits: ${stats.usdtDeposits}`);
    console.log(`${this.options.logPrefix} ├─ USDC deposits: ${stats.usdcDeposits}`);
    console.log(`${this.options.logPrefix} ├─ Errors: ${stats.errors}`);
    console.log(`${this.options.logPrefix} └─ Uptime: ${Math.round(stats.uptime / 1000)}s\n`);
  }
  
  maskAddress(address) {
    if (!address) return 'N/A';
    return address.substring(0, 6) + '...' + address.substring(address.length - 4);
  }
}

module.exports = DepositListener;
