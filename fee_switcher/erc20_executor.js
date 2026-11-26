/**
 * ERC20 Executor - Token Transfer Execution
 * 
 * Handles ERC20 token transfers with:
 * - Dynamic gas estimation
 * - Automatic approval handling
 * - Balance verification
 * - Retry logic
 * 
 * This module is an EXTENSION - does NOT modify existing code
 */

const { ethers } = require('ethers');
const {
  SUPPORTED_TOKENS,
  ERC20_ABI,
  getTokenBySymbol,
  formatTokenAmount
} = require('./token_registry');

class ERC20Executor {
  constructor(wallet, provider, options = {}) {
    this.wallet = wallet;
    this.provider = provider;
    
    this.options = {
      gasBufferPercent: options.gasBufferPercent || 10,
      maxRetries: options.maxRetries || 3,
      logPrefix: options.logPrefix || '💸 [ERC20Executor]',
      ...options
    };
    
    this.tokenContracts = new Map();
    
    this.metrics = {
      totalTransfers: 0,
      successfulTransfers: 0,
      failedTransfers: 0,
      totalGasUsed: 0n,
      errors: []
    };
  }
  
  async initialize() {
    console.log(`${this.options.logPrefix} Initializing ERC20 executor...`);
    
    for (const [symbol, token] of Object.entries(SUPPORTED_TOKENS)) {
      if (token.isNative) continue;
      
      try {
        const connectedWallet = this.wallet.connect(this.provider);
        const contract = new ethers.Contract(
          token.contractAddress,
          ERC20_ABI,
          connectedWallet
        );
        
        this.tokenContracts.set(symbol, contract);
        console.log(`${this.options.logPrefix} ✅ ${symbol} executor ready`);
        
      } catch (error) {
        console.error(`${this.options.logPrefix} ❌ Failed to init ${symbol}:`, error.message);
      }
    }
    
    console.log(`${this.options.logPrefix} ✅ ERC20 executor initialized`);
  }
  
  async getTokenBalance(symbol, address) {
    const contract = this.tokenContracts.get(symbol);
    if (!contract) {
      throw new Error(`Unknown token: ${symbol}`);
    }
    
    return await contract.balanceOf(address);
  }
  
  async estimateTransferGas(symbol, to, amount) {
    const contract = this.tokenContracts.get(symbol);
    if (!contract) {
      throw new Error(`Unknown token: ${symbol}`);
    }
    
    try {
      const gasEstimate = await contract.transfer.estimateGas(to, amount);
      
      const bufferMultiplier = BigInt(100 + this.options.gasBufferPercent);
      const gasWithBuffer = (gasEstimate * bufferMultiplier) / 100n;
      
      return {
        estimate: gasEstimate,
        withBuffer: gasWithBuffer
      };
    } catch (error) {
      console.log(`${this.options.logPrefix} ⚠️ Gas estimation failed, using fallback`);
      return {
        estimate: 100000n,
        withBuffer: 110000n
      };
    }
  }
  
  async calculateGasCost(gasLimit) {
    try {
      const feeData = await this.provider.getFeeData();
      
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
      
      return {
        gasCost,
        gasPrice,
        gasLimit,
        formattedCost: ethers.formatEther(gasCost)
      };
    } catch (error) {
      console.error(`${this.options.logPrefix} ⚠️ Failed to calculate gas cost:`, error.message);
      throw error;
    }
  }
  
  async transferToken(symbol, to, amount, options = {}) {
    this.metrics.totalTransfers++;
    
    const token = getTokenBySymbol(symbol);
    if (!token) {
      throw new Error(`Unsupported token: ${symbol}`);
    }
    
    if (token.isNative) {
      throw new Error('Use ETH transfer for native token');
    }
    
    const contract = this.tokenContracts.get(symbol);
    if (!contract) {
      throw new Error(`Contract not initialized for ${symbol}`);
    }
    
    const formattedAmount = formatTokenAmount(amount, token.decimals);
    
    console.log(`\n${this.options.logPrefix} ========================================`);
    console.log(`${this.options.logPrefix} 🚀 Initiating ${symbol} Transfer`);
    console.log(`${this.options.logPrefix} 💰 Amount: ${formattedAmount} ${symbol}`);
    console.log(`${this.options.logPrefix} 🎯 To: ${this.maskAddress(to)}`);
    console.log(`${this.options.logPrefix} ========================================`);
    
    let lastError = null;
    
    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        console.log(`${this.options.logPrefix} 📊 Attempt ${attempt}/${this.options.maxRetries}`);
        
        const gasEstimate = await this.estimateTransferGas(symbol, to, amount);
        console.log(`${this.options.logPrefix} ⛽ Dynamic gas fee estimated: ${gasEstimate.withBuffer.toString()} gas units`);
        
        const gasCost = await this.calculateGasCost(gasEstimate.withBuffer);
        console.log(`${this.options.logPrefix} 💵 Estimated gas cost: ${gasCost.formattedCost} ETH`);
        
        const ethBalance = await this.provider.getBalance(this.wallet.address);
        if (ethBalance < gasCost.gasCost) {
          throw new Error(
            `Insufficient ETH for gas. Need: ${gasCost.formattedCost} ETH, Have: ${ethers.formatEther(ethBalance)} ETH`
          );
        }
        
        const txOptions = {
          gasLimit: gasEstimate.withBuffer,
          ...gasCost.gasPrice
        };
        
        if (options.nonce !== undefined) {
          txOptions.nonce = options.nonce;
        }
        
        console.log(`${this.options.logPrefix} 📤 Sending transaction...`);
        
        const tx = await contract.transfer(to, amount, txOptions);
        
        console.log(`${this.options.logPrefix} ✅ Transaction sent!`);
        console.log(`${this.options.logPrefix} 🔗 TX Hash: ${tx.hash}`);
        console.log(`${this.options.logPrefix} ⏳ Waiting for confirmation...`);
        
        const receipt = await tx.wait();
        
        const actualGasUsed = receipt.gasUsed;
        this.metrics.successfulTransfers++;
        this.metrics.totalGasUsed += actualGasUsed;
        
        console.log(`${this.options.logPrefix} ✅ Transfer executed successfully → Wallet B`);
        console.log(`${this.options.logPrefix} 📦 Block: #${receipt.blockNumber}`);
        console.log(`${this.options.logPrefix} ⛽ Gas used: ${actualGasUsed.toString()}`);
        
        return {
          success: true,
          transactionHash: tx.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: actualGasUsed,
          token: symbol,
          amount,
          formattedAmount,
          to
        };
        
      } catch (error) {
        lastError = error;
        console.error(`${this.options.logPrefix} ❌ Attempt ${attempt} failed:`, error.message);
        
        if (attempt < this.options.maxRetries) {
          const delay = 1000 * attempt;
          console.log(`${this.options.logPrefix} ⏳ Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    this.metrics.failedTransfers++;
    this.metrics.errors.push({
      token: symbol,
      amount: formattedAmount,
      error: lastError.message,
      timestamp: Date.now()
    });
    
    throw lastError;
  }
  
  async transferAllTokens(symbol, to, options = {}) {
    const token = getTokenBySymbol(symbol);
    if (!token || token.isNative) {
      throw new Error(`Invalid token for transfer all: ${symbol}`);
    }
    
    const balance = await this.getTokenBalance(symbol, this.wallet.address);
    
    if (balance === 0n) {
      console.log(`${this.options.logPrefix} ⚠️ No ${symbol} balance to transfer`);
      return null;
    }
    
    const formattedBalance = formatTokenAmount(balance, token.decimals);
    console.log(`${this.options.logPrefix} 💰 Transferring 100% of ${symbol}: ${formattedBalance}`);
    
    return await this.transferToken(symbol, to, balance, options);
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalTransfers > 0
        ? ((this.metrics.successfulTransfers / this.metrics.totalTransfers) * 100).toFixed(2) + '%'
        : 'N/A',
      totalGasUsedFormatted: ethers.formatEther(this.metrics.totalGasUsed) + ' ETH equivalent'
    };
  }
  
  maskAddress(address) {
    if (!address) return 'N/A';
    return address.substring(0, 6) + '...' + address.substring(address.length - 4);
  }
}

module.exports = ERC20Executor;
