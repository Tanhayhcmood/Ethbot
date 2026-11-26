const fs = require('fs').promises;
const path = require('path');
const AtomicFileWriter = require('./fileOperations');

class NonceManager {
  constructor(walletAddress, provider) {
    this.walletAddress = walletAddress.toLowerCase();
    this.provider = provider;
    this.nonceFilePath = path.join(process.cwd(), 'data', `nonce_${this.walletAddress}.json`);
    this.lockFilePath = path.join(process.cwd(), 'data', `nonce_${this.walletAddress}.lock`);
    this.localNonce = null;
    this.cachedNetworkNonce = null;
    this.cachedNetworkNonceAt = 0;
    this.isInitialized = false;
    this.lockTimeout = 10000;
    this.staleLockTimeout = 30000;
  }

  async ensureDataDirectory() {
    const dataDir = path.join(process.cwd(), 'data');
    try {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  async acquireLock(timeout = null) {
    const lockTimeout = timeout || this.lockTimeout;
    const startTime = Date.now();
    
    while (Date.now() - startTime < lockTimeout) {
      try {
        await fs.writeFile(this.lockFilePath, Date.now().toString(), { flag: 'wx' });
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') {
          try {
            const lockContent = await fs.readFile(this.lockFilePath, 'utf8');
            const lockTime = parseInt(lockContent);
            
            if (Date.now() - lockTime > this.staleLockTimeout) {
              console.log('🔓 Removing stale nonce lock file');
              await fs.unlink(this.lockFilePath);
              continue;
            }
          } catch (readErr) {
            if (readErr.code === 'ENOENT') {
              continue;
            }
          }
          
          await new Promise(resolve => setTimeout(resolve, 50));
        } else {
          throw error;
        }
      }
    }
    
    throw new Error(`Failed to acquire nonce lock after ${lockTimeout}ms`);
  }

  async releaseLock() {
    try {
      await fs.unlink(this.lockFilePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('⚠️ Warning: Could not release nonce lock:', error.message);
      }
    }
  }

  async loadLocalNonce() {
    try {
      const data = await fs.readFile(this.nonceFilePath, 'utf8');
      const nonceData = JSON.parse(data);
      return nonceData.nonce;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      console.error('⚠️ Error reading nonce file:', error.message);
      return null;
    }
  }

  async saveLocalNonce(nonce) {
    const nonceData = {
      nonce: nonce,
      address: this.walletAddress,
      lastUpdated: new Date().toISOString(),
      timestamp: Date.now()
    };
    
    try {
      // CRITICAL FIX C-1: Use atomic write to prevent corruption
      await AtomicFileWriter.writeJSON(this.nonceFilePath, nonceData, { mode: 0o600 });
    } catch (error) {
      console.error('⚠️ Error saving nonce file:', error.message);
      throw error;
    }
  }

  async getNetworkNonce() {
    try {
      const nonce = await this.provider.getTransactionCount(this.walletAddress, 'pending');
      this.cachedNetworkNonce = nonce;
      this.cachedNetworkNonceAt = Date.now();
      return nonce;
    } catch (error) {
      console.error('⚠️ Error fetching network nonce:', error.message);
      throw error;
    }
  }

  // Background refresh (called on every block) so the hot path needs no RPC for the nonce
  async refreshNetworkNonce() {
    return this.getNetworkNonce();
  }

  // Next nonce we would use, without taking the lock or sending anything (for pre-signing)
  async peekNextNonce() {
    if (!this.isInitialized) {
      await this.initialize();
    }
    const localNonce = await this.loadLocalNonce();
    const networkNonce = await this.getNetworkNonceFast();
    return (localNonce !== null && localNonce >= networkNonce) ? localNonce : networkNonce;
  }

  async getNetworkNonceFast(maxAgeMs = 30000) {
    if (this.cachedNetworkNonce !== null && (Date.now() - this.cachedNetworkNonceAt) < maxAgeMs) {
      return this.cachedNetworkNonce;
    }
    return this.getNetworkNonce();
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }

    await this.ensureDataDirectory();

    const localNonce = await this.loadLocalNonce();
    const networkNonce = await this.getNetworkNonce();

    if (localNonce === null) {
      console.log(`📝 No local nonce found, syncing with network: ${networkNonce}`);
      this.localNonce = networkNonce;
      await this.saveLocalNonce(networkNonce);
    } else if (localNonce < networkNonce) {
      console.log(`🔄 Local nonce (${localNonce}) outdated, syncing with network: ${networkNonce}`);
      this.localNonce = networkNonce;
      await this.saveLocalNonce(networkNonce);
    } else if (localNonce > networkNonce) {
      console.log(`⚠️ Local nonce (${localNonce}) ahead of network (${networkNonce})`);
      console.log(`📝 Using local nonce - pending transactions may exist`);
      this.localNonce = localNonce;
    } else {
      console.log(`✅ Nonce synced: ${networkNonce}`);
      this.localNonce = networkNonce;
    }

    this.isInitialized = true;
  }

  async getNextNonce() {
    if (!this.isInitialized) {
      await this.initialize();
    }

    let lockAcquired = false;
    try {
      await this.acquireLock();
      lockAcquired = true;

      const localNonce = await this.loadLocalNonce();
      const networkNonce = await this.getNetworkNonce();

      let nonceToUse;

      if (localNonce !== null && localNonce >= networkNonce) {
        nonceToUse = localNonce;
      } else {
        console.log(`🔄 Network nonce (${networkNonce}) is higher, resetting local nonce`);
        nonceToUse = networkNonce;
      }

      this.localNonce = nonceToUse;
      
      console.log(`🔢 Using nonce: ${nonceToUse}`);
      
      return nonceToUse;

    } finally {
      if (lockAcquired) {
        await this.releaseLock();
      }
    }
  }

  async withNonce(callback) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    let lockAcquired = false;
    let nonce = null;
    let nonceIncremented = false;
    
    try {
      await this.acquireLock();
      lockAcquired = true;

      const localNonce = await this.loadLocalNonce();
      const networkNonce = await this.getNetworkNonceFast();

      if (localNonce !== null && localNonce >= networkNonce) {
        nonce = localNonce;
      } else {
        console.log(`🔄 Network nonce (${networkNonce}) is higher, resetting local nonce`);
        nonce = networkNonce;
      }

      this.localNonce = nonce;
      console.log(`🔢 Using nonce: ${nonce} (atomic operation)`);
      
      // CRITICAL FIX C-4: Execute callback FIRST - if it fails, we don't increment
      const result = await callback(nonce);
      
      // Only increment and save if callback succeeded
      const previousNonce = this.localNonce;
      this.localNonce++;
      nonceIncremented = true; // Set flag BEFORE save so rollback works
      
      try {
        await this.saveLocalNonce(this.localNonce);
        console.log(`✅ Nonce incremented to: ${this.localNonce} (atomic commit)`);
      } catch (saveError) {
        // CRITICAL: If save fails, rollback immediately
        console.error(`❌ Failed to save nonce: ${saveError.message}`);
        this.localNonce = previousNonce;
        nonceIncremented = false;
        throw saveError;
      }
      
      return result;

    } catch (error) {
      console.error('⚠️ Atomic nonce operation failed:', error.message);
      
      // CRITICAL FIX C-4: Rollback if we incremented but failed to persist
      if (nonceIncremented && this.localNonce > nonce) {
        console.log(`🔄 Rolling back nonce from ${this.localNonce} to ${nonce}`);
        this.localNonce = nonce;
        // Try to re-persist the original nonce
        try {
          await this.saveLocalNonce(nonce);
        } catch (rollbackError) {
          console.error(`❌ Rollback persist failed: ${rollbackError.message}`);
        }
      }
      
      // If callback failed, nonce was not incremented
      if (!nonceIncremented) {
        console.log(`ℹ️  Nonce not incremented - transaction was not sent`);
      }
      
      throw error;
    } finally {
      if (lockAcquired) {
        await this.releaseLock();
      }
    }
  }

  async incrementNonce() {
    let lockAcquired = false;
    try {
      await this.acquireLock();
      lockAcquired = true;

      // CRITICAL FIX C-4: Verify local nonce is valid before incrementing
      const networkNonce = await this.getNetworkNonce();
      const currentLocal = this.localNonce;
      
      // If local nonce somehow got behind network, sync first
      if (currentLocal < networkNonce) {
        console.log(`⚠️ Nonce desync detected before increment: local=${currentLocal}, network=${networkNonce}`);
        this.localNonce = networkNonce;
        console.log(`🔄 Nonce synced to network value: ${networkNonce}`);
      }
      
      this.localNonce++;
      await this.saveLocalNonce(this.localNonce);
      
      console.log(`✅ Nonce incremented to: ${this.localNonce}`);

    } catch (error) {
      console.error('⚠️ Error incrementing nonce:', error.message);
      throw error;
    } finally {
      if (lockAcquired) {
        await this.releaseLock();
      }
    }
  }

  async resetNonce() {
    let lockAcquired = false;
    try {
      await this.acquireLock();
      lockAcquired = true;

      const networkNonce = await this.getNetworkNonce();
      this.localNonce = networkNonce;
      await this.saveLocalNonce(networkNonce);
      
      console.log(`🔄 Nonce reset to network value: ${networkNonce}`);
      
      return networkNonce;

    } finally {
      if (lockAcquired) {
        await this.releaseLock();
      }
    }
  }

  async handleNonceError(error) {
    if (error.message.includes('nonce') || error.code === 'NONCE_EXPIRED' || 
        error.message.includes('replacement transaction') || 
        error.message.includes('already known')) {
      
      console.log('⚠️ Nonce error detected, resetting to network nonce...');
      return await this.resetNonce();
    }
    throw error;
  }

  getCurrentNonce() {
    return this.localNonce;
  }

  async getNonceStatus() {
    const localNonce = await this.loadLocalNonce();
    const networkNonce = await this.getNetworkNonce();
    
    return {
      local: localNonce,
      network: networkNonce,
      current: this.localNonce,
      synchronized: localNonce === networkNonce,
      gap: localNonce !== null ? localNonce - networkNonce : null
    };
  }

  // CRITICAL FIX C-4: Verify and repair nonce consistency
  async verifyAndRepairNonce() {
    let lockAcquired = false;
    
    try {
      console.log('🔍 Verifying nonce consistency...');
      
      await this.acquireLock();
      lockAcquired = true;
      
      const localNonce = await this.loadLocalNonce();
      const networkNonce = await this.getNetworkNonce();
      
      if (localNonce === null) {
        console.log('⚠️ No local nonce found - syncing with network');
        this.localNonce = networkNonce;
        await this.saveLocalNonce(networkNonce);
        return { repaired: true, from: null, to: networkNonce };
      }
      
      // Check for corruption: local nonce should never be less than network
      // unless there are pending transactions
      if (localNonce < networkNonce) {
        console.log(`⚠️ Local nonce (${localNonce}) < network (${networkNonce}) - repairing`);
        this.localNonce = networkNonce;
        await this.saveLocalNonce(networkNonce);
        return { repaired: true, from: localNonce, to: networkNonce };
      }
      
      // Check if gap is suspiciously large (more than 10 pending txs is unusual)
      const gap = localNonce - networkNonce;
      if (gap > 10) {
        console.log(`⚠️ Large nonce gap detected: ${gap} pending transactions`);
        console.log(`ℹ️  This could indicate stuck transactions or nonce corruption`);
        return { 
          repaired: false, 
          warning: true, 
          gap, 
          local: localNonce, 
          network: networkNonce 
        };
      }
      
      console.log('✅ Nonce consistency verified');
      return { repaired: false, local: localNonce, network: networkNonce };
      
    } finally {
      if (lockAcquired) {
        await this.releaseLock();
      }
    }
  }
}

module.exports = NonceManager;
