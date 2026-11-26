class MetricsCollector {
  constructor() {
    this.metrics = {
      transactions: {
        total: 0,
        successful: 0,
        failed: 0,
        rbfReplaced: 0
      },
      
      performance: {
        avgCheckDuration: 0,
        avgTransferDuration: 0,
        totalChecks: 0,
        totalTransfers: 0,
        lastCheckDuration: 0,
        lastTransferDuration: 0
      },
      
      rpc: {
        totalCalls: 0,
        failedCalls: 0,
        avgResponseTime: 0,
        failoverEvents: 0,
        currentProvider: null
      },
      
      errors: {
        total: 0,
        byType: {},
        lastError: null,
        lastErrorTime: null
      },
      
      nonce: {
        currentNonce: 0,
        conflicts: 0,
        syncs: 0
      },
      
      telegram: {
        messagesSent: 0,
        messagesFailed: 0,
        authAttempts: 0,
        authFailures: 0
      },
      
      system: {
        startTime: Date.now(),
        uptime: 0,
        memoryUsage: 0,
        cpuUsage: 0
      }
    };
    
    this.recentErrors = [];
    this.maxRecentErrors = 10;
    
    this.recentTransactions = [];
    this.maxRecentTransactions = 20;
  }
  
  recordTransaction(txData) {
    this.metrics.transactions.total++;
    
    if (txData.success) {
      this.metrics.transactions.successful++;
    } else {
      this.metrics.transactions.failed++;
    }
    
    if (txData.rbfReplaced) {
      this.metrics.transactions.rbfReplaced++;
    }
    
    this.recentTransactions.unshift({
      timestamp: Date.now(),
      ...txData
    });
    
    if (this.recentTransactions.length > this.maxRecentTransactions) {
      this.recentTransactions.pop();
    }
  }
  
  recordCheckDuration(duration) {
    const totalChecks = this.metrics.performance.totalChecks;
    const currentAvg = this.metrics.performance.avgCheckDuration;
    
    this.metrics.performance.totalChecks++;
    this.metrics.performance.lastCheckDuration = duration;
    this.metrics.performance.avgCheckDuration = 
      (currentAvg * totalChecks + duration) / (totalChecks + 1);
  }
  
  recordTransferDuration(duration) {
    const totalTransfers = this.metrics.performance.totalTransfers;
    const currentAvg = this.metrics.performance.avgTransferDuration;
    
    this.metrics.performance.totalTransfers++;
    this.metrics.performance.lastTransferDuration = duration;
    this.metrics.performance.avgTransferDuration = 
      (currentAvg * totalTransfers + duration) / (totalTransfers + 1);
  }
  
  recordRPCCall(success, responseTime, provider) {
    this.metrics.rpc.totalCalls++;
    this.metrics.rpc.currentProvider = provider;
    
    if (!success) {
      this.metrics.rpc.failedCalls++;
    }
    
    const totalCalls = this.metrics.rpc.totalCalls;
    const currentAvg = this.metrics.rpc.avgResponseTime;
    this.metrics.rpc.avgResponseTime = 
      (currentAvg * (totalCalls - 1) + responseTime) / totalCalls;
  }
  
  recordRPCFailover() {
    this.metrics.rpc.failoverEvents++;
  }
  
  recordError(error, type = 'unknown') {
    this.metrics.errors.total++;
    this.metrics.errors.lastError = error.message || String(error);
    this.metrics.errors.lastErrorTime = Date.now();
    
    if (!this.metrics.errors.byType[type]) {
      this.metrics.errors.byType[type] = 0;
    }
    this.metrics.errors.byType[type]++;
    
    this.recentErrors.unshift({
      timestamp: Date.now(),
      type,
      message: error.message || String(error),
      stack: error.stack
    });
    
    if (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors.pop();
    }
  }
  
  updateNonce(nonce) {
    this.metrics.nonce.currentNonce = nonce;
  }
  
  recordNonceConflict() {
    this.metrics.nonce.conflicts++;
  }
  
  recordNonceSync() {
    this.metrics.nonce.syncs++;
  }
  
  recordTelegramMessage(success) {
    if (success) {
      this.metrics.telegram.messagesSent++;
    } else {
      this.metrics.telegram.messagesFailed++;
    }
  }
  
  recordTelegramAuth(success) {
    this.metrics.telegram.authAttempts++;
    if (!success) {
      this.metrics.telegram.authFailures++;
    }
  }
  
  updateSystemMetrics() {
    this.metrics.system.uptime = Date.now() - this.metrics.system.startTime;
    
    const memUsage = process.memoryUsage();
    this.metrics.system.memoryUsage = Math.round(memUsage.heapUsed / 1024 / 1024);
  }
  
  getMetrics() {
    this.updateSystemMetrics();
    return this.metrics;
  }
  
  getSummary() {
    this.updateSystemMetrics();
    
    const uptime = this.metrics.system.uptime;
    const hours = Math.floor(uptime / 3600000);
    const minutes = Math.floor((uptime % 3600000) / 60000);
    const seconds = Math.floor((uptime % 60000) / 1000);
    
    return {
      uptime: `${hours}h ${minutes}m ${seconds}s`,
      transactions: this.metrics.transactions,
      performance: {
        avgCheckTime: `${this.metrics.performance.avgCheckDuration.toFixed(2)}ms`,
        avgTransferTime: `${this.metrics.performance.avgTransferDuration.toFixed(2)}ms`,
        totalChecks: this.metrics.performance.totalChecks
      },
      rpc: {
        totalCalls: this.metrics.rpc.totalCalls,
        failureRate: this.metrics.rpc.totalCalls > 0 
          ? `${((this.metrics.rpc.failedCalls / this.metrics.rpc.totalCalls) * 100).toFixed(2)}%`
          : '0%',
        avgResponseTime: `${this.metrics.rpc.avgResponseTime.toFixed(2)}ms`,
        failovers: this.metrics.rpc.failoverEvents
      },
      errors: {
        total: this.metrics.errors.total,
        lastError: this.metrics.errors.lastError,
        byType: this.metrics.errors.byType
      },
      system: {
        memory: `${this.metrics.system.memoryUsage} MB`,
        uptime: `${hours}h ${minutes}m ${seconds}s`
      }
    };
  }
  
  getRecentErrors() {
    return this.recentErrors;
  }
  
  getRecentTransactions() {
    return this.recentTransactions;
  }
  
  reset() {
    this.metrics = {
      transactions: { total: 0, successful: 0, failed: 0, rbfReplaced: 0 },
      performance: { avgCheckDuration: 0, avgTransferDuration: 0, totalChecks: 0, totalTransfers: 0, lastCheckDuration: 0, lastTransferDuration: 0 },
      rpc: { totalCalls: 0, failedCalls: 0, avgResponseTime: 0, failoverEvents: 0, currentProvider: null },
      errors: { total: 0, byType: {}, lastError: null, lastErrorTime: null },
      nonce: { currentNonce: 0, conflicts: 0, syncs: 0 },
      telegram: { messagesSent: 0, messagesFailed: 0, authAttempts: 0, authFailures: 0 },
      system: { startTime: Date.now(), uptime: 0, memoryUsage: 0, cpuUsage: 0 }
    };
    this.recentErrors = [];
    this.recentTransactions = [];
  }
}

module.exports = MetricsCollector;
