/**
 * Auto Fee Token Switcher - Trust Wallet FlexGas Style
 * 
 * Main orchestrator module that:
 * 1. Detects incoming deposits (ETH, USDT, USDC)
 * 2. Automatically identifies the deposited token
 * 3. Switches fee handling based on token type
 * 4. Executes transfers to Wallet B
 * 
 * This module is an EXTENSION - does NOT modify existing code
 * 
 * IMPORTANT NOTE:
 * On Ethereum mainnet, gas fees MUST be paid in ETH.
 * For ERC20 tokens, this module handles the token transfer
 * but requires ETH for gas fees. True gasless transactions
 * require a relayer network or Account Abstraction (ERC-4337).
 */

const { ethers } = require('ethers');
const DepositListener = require('./deposit_listener');
const ERC20Executor = require('./erc20_executor');
const {
  SUPPORTED_TOKENS,
  getTokenBySymbol,
  formatTokenAmount
} = require('./token_registry');

class AutoFeeTokenSwitcher {
  constructor(config) {
    this.config = {
      privateKey: config.privateKey,
      destinationAddress: config.destinationAddress,
      provider: config.provider,
      monitoredAddress: config.monitoredAddress,
      telegramNotifier: config.telegramNotifier || null,
      logPrefix: config.logPrefix || '🔄 [AutoFeeSwitcher]',
      ...config
    };
    
    this.wallet = new ethers.Wallet(this.config.privateKey, this.config.provider);
    this.depositListener = null;
    this.erc20Executor = null;
    
    this.isRunning = false;
    this.processingQueue = [];
    this.isProcessing = false;
    
    this.currentFeeToken = 'ETH';
    
    this.metrics = {
      totalDepositsProcessed: 0,
      ethTransfers: 0,
      usdtTransfers: 0,
      usdcTransfers: 0,
      errors: 0,
      lastTransfer: null,
      startTime: null
    };
    
    this.status = {
      running: false,
      currentFeeToken: 'ETH',
      lastDeposit: null,
      lastTransfer: null
    };
  }
  
  async start() {
    if (this.isRunning) {
      console.log(`${this.config.logPrefix} Already running`);
      return;
    }
    
    console.log(`\n${this.config.logPrefix} ╔═══════════════════════════════════════════════╗`);
    console.log(`${this.config.logPrefix} ║  🔥 AUTO FEE TOKEN SWITCHER - FlexGas Style   ║`);
    console.log(`${this.config.logPrefix} ╠═══════════════════════════════════════════════╣`);
    console.log(`${this.config.logPrefix} ║  Supported Tokens: ETH, USDT, USDC            ║`);
    console.log(`${this.config.logPrefix} ║  Detection Speed: < 1 second                  ║`);
    console.log(`${this.config.logPrefix} ╚═══════════════════════════════════════════════╝\n`);
    
    try {
      this.depositListener = new DepositListener(
        this.config.provider,
        this.config.monitoredAddress,
        {
          enableETH: true,
          enableUSDT: true,
          enableUSDC: true,
          logPrefix: '👁️ [Listener]'
        }
      );
      
      this.erc20Executor = new ERC20Executor(
        this.wallet,
        this.config.provider,
        {
          gasBufferPercent: 15,
          maxRetries: 3,
          logPrefix: '💸 [Executor]'
        }
      );
      
      await this.erc20Executor.initialize();
      
      await this.depositListener.start(
        async (depositInfo) => await this.handleDeposit(depositInfo),
        (error, context) => this.handleError(error, context)
      );
      
      this.isRunning = true;
      this.metrics.startTime = Date.now();
      this.status.running = true;
      
      console.log(`${this.config.logPrefix} ✅ Auto Fee Token Switcher is now active`);
      console.log(`${this.config.logPrefix} 📍 Monitoring: ${this.maskAddress(this.config.monitoredAddress)}`);
      console.log(`${this.config.logPrefix} 🎯 Destination: ${this.maskAddress(this.config.destinationAddress)}\n`);
      
    } catch (error) {
      console.error(`${this.config.logPrefix} ❌ Failed to start:`, error.message);
      throw error;
    }
  }
  
  async stop() {
    if (!this.isRunning) return;
    
    console.log(`${this.config.logPrefix} 🛑 Stopping Auto Fee Token Switcher...`);
    
    if (this.depositListener) {
      await this.depositListener.stop();
    }
    
    this.isRunning = false;
    this.status.running = false;
    
    console.log(`${this.config.logPrefix} ✅ Auto Fee Token Switcher stopped`);
    this.logStats();
  }
  
  async handleDeposit(depositInfo) {
    console.log(`\n${this.config.logPrefix} ════════════════════════════════════════`);
    console.log(`${this.config.logPrefix} 🔔 NEW DEPOSIT DETECTED!`);
    console.log(`${this.config.logPrefix} ════════════════════════════════════════`);
    
    const { token, formattedAmount, isNative } = depositInfo;
    
    console.log(`${this.config.logPrefix} 📊 Detected deposit: ${token}, switching network fee token → ${token}`);
    
    this.currentFeeToken = token;
    this.status.currentFeeToken = token;
    this.status.lastDeposit = {
      token,
      amount: formattedAmount,
      timestamp: Date.now()
    };
    
    this.processingQueue.push(depositInfo);
    
    if (!this.isProcessing) {
      await this.processQueue();
    }
  }
  
  async processQueue() {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    while (this.processingQueue.length > 0) {
      const depositInfo = this.processingQueue.shift();
      
      try {
        await this.executeTransfer(depositInfo);
        this.metrics.totalDepositsProcessed++;
      } catch (error) {
        this.metrics.errors++;
        console.error(`${this.config.logPrefix} ❌ Transfer failed:`, error.message);
      }
    }
    
    this.isProcessing = false;
  }
  
  async executeTransfer(depositInfo) {
    const { token, amount, formattedAmount, isNative } = depositInfo;
    
    console.log(`\n${this.config.logPrefix} 🚀 Executing ${token} Transfer`);
    console.log(`${this.config.logPrefix} 💰 Deposit Amount: ${formattedAmount} ${token}`);
    console.log(`${this.config.logPrefix} 🎯 To: ${this.maskAddress(this.config.destinationAddress)}`);
    
    try {
      let result;
      
      if (isNative) {
        result = await this.executeETHTransfer(amount);
        this.metrics.ethTransfers++;
      } else {
        result = await this.executeERC20Transfer(token, amount);
        if (token === 'USDT') this.metrics.usdtTransfers++;
        if (token === 'USDC') this.metrics.usdcTransfers++;
      }
      
      if (result) {
        this.metrics.lastTransfer = {
          token,
          amount: formattedAmount,
          txHash: result.transactionHash,
          timestamp: Date.now()
        };
        this.status.lastTransfer = this.metrics.lastTransfer;
        
        console.log(`${this.config.logPrefix} ✅ Transfer executed successfully → Wallet B`);
        
        await this.sendNotification(token, formattedAmount, result);
      }
      
      return result;
      
    } catch (error) {
      console.error(`${this.config.logPrefix} ❌ Transfer execution failed:`, error.message);
      throw error;
    }
  }
  
  async executeETHTransfer(depositAmount) {
    console.log(`${this.config.logPrefix} ⛽ Using ETH for gas fees (native transfer)`);
    
    const currentBalance = await this.config.provider.getBalance(this.config.monitoredAddress);
    
    if (currentBalance === 0n) {
      console.log(`${this.config.logPrefix} ⚠️ No ETH balance to transfer`);
      return null;
    }
    
    const feeData = await this.config.provider.getFeeData();
    const gasLimit = 21000n;
    
    let gasCost;
    let gasPrice;
    
    if (feeData.maxFeePerGas) {
      gasPrice = {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
      };
      gasCost = gasLimit * feeData.maxFeePerGas;
    } else {
      gasPrice = { gasPrice: feeData.gasPrice };
      gasCost = gasLimit * feeData.gasPrice;
    }
    
    const bufferPercent = 5n;
    const buffer = (gasCost * bufferPercent) / 100n;
    const totalGasCost = gasCost + buffer;
    
    let amountToSend;
    
    if (depositAmount && depositAmount > 0n) {
      amountToSend = depositAmount - totalGasCost;
      
      if (amountToSend <= 0n) {
        console.log(`${this.config.logPrefix} ⚠️ Deposit too small after gas deduction, transferring full balance`);
        amountToSend = currentBalance - totalGasCost;
      }
    } else {
      amountToSend = currentBalance - totalGasCost;
    }
    
    if (amountToSend <= 0n) {
      throw new Error(`Insufficient balance after gas. Balance: ${ethers.formatEther(currentBalance)} ETH, Gas needed: ${ethers.formatEther(totalGasCost)} ETH`);
    }
    
    if (amountToSend > currentBalance - totalGasCost) {
      amountToSend = currentBalance - totalGasCost;
    }
    
    console.log(`${this.config.logPrefix} 💵 Dynamic gas fee estimated: ${ethers.formatEther(totalGasCost)} ETH`);
    console.log(`${this.config.logPrefix} 📤 Sending: ${ethers.formatEther(amountToSend)} ETH`);
    
    const connectedWallet = this.wallet.connect(this.config.provider);
    
    const tx = await connectedWallet.sendTransaction({
      to: this.config.destinationAddress,
      value: amountToSend,
      gasLimit: gasLimit,
      ...gasPrice
    });
    
    console.log(`${this.config.logPrefix} 🔗 TX Hash: ${tx.hash}`);
    console.log(`${this.config.logPrefix} ⏳ Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    
    return {
      success: true,
      transactionHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      token: 'ETH',
      amount: amountToSend,
      formattedAmount: ethers.formatEther(amountToSend)
    };
  }
  
  async executeERC20Transfer(token, depositAmount) {
    const tokenInfo = getTokenBySymbol(token);
    
    console.log(`${this.config.logPrefix} ⛽ Gas fee will be paid in ETH (ERC20 transfer requires ETH)`);
    console.log(`${this.config.logPrefix} 📝 Token type: ${token} (${tokenInfo.name})`);
    
    if (depositAmount && depositAmount > 0n) {
      return await this.erc20Executor.transferToken(
        token,
        this.config.destinationAddress,
        depositAmount
      );
    } else {
      return await this.erc20Executor.transferAllTokens(
        token,
        this.config.destinationAddress
      );
    }
  }
  
  async sendNotification(token, amount, result) {
    if (!this.config.telegramNotifier) return;
    
    try {
      const message = 
        `👤 <b>Auto Fee Switcher</b>\n\n` +
        `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `┃ 🔄 <b>Token Transfer Complete</b>\n` +
        `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 <b>Token:</b> ${token}\n` +
        `💵 <b>Amount:</b> ${amount}\n` +
        `🔗 <b>TX Hash:</b> <code>${result.transactionHash}</code>\n` +
        `📦 <b>Block:</b> #${result.blockNumber}\n\n` +
        `✅ <b>Transferred to Wallet B</b>`;
      
      await this.config.telegramNotifier(message);
    } catch (error) {
      console.error(`${this.config.logPrefix} ⚠️ Notification failed:`, error.message);
    }
  }
  
  handleError(error, context) {
    console.error(`${this.config.logPrefix} ❌ Error in ${context}:`, error.message);
    this.metrics.errors++;
  }
  
  getStatus() {
    return {
      ...this.status,
      metrics: this.getMetrics(),
      depositListenerMetrics: this.depositListener?.getMetrics() || null,
      executorMetrics: this.erc20Executor?.getMetrics() || null
    };
  }
  
  getMetrics() {
    const uptime = this.metrics.startTime ? Date.now() - this.metrics.startTime : 0;
    
    return {
      ...this.metrics,
      uptime,
      uptimeFormatted: `${Math.round(uptime / 1000)}s`
    };
  }
  
  logStats() {
    const stats = this.getMetrics();
    
    console.log(`\n${this.config.logPrefix} 📊 Auto Fee Switcher Statistics:`);
    console.log(`${this.config.logPrefix} ├─ Total deposits processed: ${stats.totalDepositsProcessed}`);
    console.log(`${this.config.logPrefix} ├─ ETH transfers: ${stats.ethTransfers}`);
    console.log(`${this.config.logPrefix} ├─ USDT transfers: ${stats.usdtTransfers}`);
    console.log(`${this.config.logPrefix} ├─ USDC transfers: ${stats.usdcTransfers}`);
    console.log(`${this.config.logPrefix} ├─ Errors: ${stats.errors}`);
    console.log(`${this.config.logPrefix} └─ Uptime: ${stats.uptimeFormatted}\n`);
  }
  
  maskAddress(address) {
    if (!address) return 'N/A';
    return address.substring(0, 6) + '...' + address.substring(address.length - 4);
  }
}

module.exports = AutoFeeTokenSwitcher;
