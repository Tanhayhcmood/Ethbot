const fs = require('fs').promises;
const path = require('path');

class InstanceLockManager {
  constructor() {
    this.lockFilePath = path.join(process.cwd(), 'data', 'bot.lock');
    this.pid = process.pid;
    this.isLocked = false;
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

  async isProcessRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  async checkExistingLock() {
    try {
      const lockData = await fs.readFile(this.lockFilePath, 'utf8');
      const lockInfo = JSON.parse(lockData);
      
      const isRunning = await this.isProcessRunning(lockInfo.pid);
      
      if (isRunning) {
        return {
          locked: true,
          pid: lockInfo.pid,
          startTime: lockInfo.startTime,
          stale: false
        };
      } else {
        console.log(`🔓 Found stale lock file from PID ${lockInfo.pid} (process not running)`);
        await fs.unlink(this.lockFilePath);
        return {
          locked: false,
          stale: true
        };
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { locked: false };
      }
      throw error;
    }
  }

  async acquireLock() {
    await this.ensureDataDirectory();

    const existingLock = await this.checkExistingLock();
    
    if (existingLock.locked && !existingLock.stale) {
      const uptimeSeconds = Math.floor((Date.now() - new Date(existingLock.startTime).getTime()) / 1000);
      throw new Error(
        `❌ Another bot instance is already running!\n` +
        `   PID: ${existingLock.pid}\n` +
        `   Started: ${existingLock.startTime}\n` +
        `   Uptime: ${uptimeSeconds}s\n\n` +
        `Please stop the other instance before starting a new one.`
      );
    }

    const lockData = {
      pid: this.pid,
      startTime: new Date().toISOString(),
      timestamp: Date.now()
    };

    try {
      await fs.writeFile(this.lockFilePath, JSON.stringify(lockData, null, 2), { 
        flag: 'wx',
        mode: 0o600
      });
      this.isLocked = true;
      console.log(`🔒 Instance lock acquired (PID: ${this.pid})`);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        const retryCheck = await this.checkExistingLock();
        if (retryCheck.locked) {
          throw new Error(
            `❌ Race condition: Another instance acquired the lock\n` +
            `   PID: ${retryCheck.pid}\n` +
            `Please try again in a few seconds.`
          );
        }
        return await this.acquireLock();
      }
      throw error;
    }
  }

  async releaseLock() {
    if (!this.isLocked) {
      return;
    }

    try {
      const lockData = await fs.readFile(this.lockFilePath, 'utf8');
      const lockInfo = JSON.parse(lockData);
      
      if (lockInfo.pid === this.pid) {
        await fs.unlink(this.lockFilePath);
        this.isLocked = false;
        console.log(`🔓 Instance lock released (PID: ${this.pid})`);
      } else {
        console.warn(`⚠️ Lock file owned by different PID (${lockInfo.pid}), not removing`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('⚠️ Error releasing lock:', error.message);
      }
    }
  }

  async getLockStatus() {
    try {
      const lockData = await fs.readFile(this.lockFilePath, 'utf8');
      const lockInfo = JSON.parse(lockData);
      const isRunning = await this.isProcessRunning(lockInfo.pid);
      
      return {
        locked: true,
        pid: lockInfo.pid,
        startTime: lockInfo.startTime,
        running: isRunning,
        uptime: Math.floor((Date.now() - lockInfo.timestamp) / 1000)
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { locked: false };
      }
      throw error;
    }
  }

  async forceUnlock() {
    try {
      await fs.unlink(this.lockFilePath);
      console.log('🔓 Lock forcefully removed');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('ℹ️ No lock file to remove');
        return false;
      }
      throw error;
    }
  }
}

module.exports = InstanceLockManager;
