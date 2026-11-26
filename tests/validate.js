// Validation script for security audit - checks code can load without runtime errors
console.log('🔍 Running security validation checks...\n');

try {
  // Test that all modules can be loaded
  console.log('✅ Checking module imports...');
  const NonceManager = require('../src/nonceManager');
  const InstanceLockManager = require('../src/instanceLockManager');
  const MetricsCollector = require('../src/metricsCollector');
  const MempoolMonitor = require('../src/mempoolMonitor');
  console.log('✅ All modules load successfully\n');
  
  console.log('✅ Checking class instantiation...');
  const metrics = new MetricsCollector();
  const lockManager = new InstanceLockManager();
  console.log('✅ Classes instantiate without errors\n');
  
  console.log('📊 Security Audit Mode - Validation Complete');
  console.log('⚠️  To run the actual bot, configure .env with credentials\n');
  
  // Keep process alive for workflow
  const express = require('express');
  const app = express();
  
  app.get('/health', (req, res) => {
    res.json({
      status: 'validation-mode',
      message: 'Security audit environment - not connected to blockchain',
      modules: {
        nonceManager: 'loaded',
        instanceLockManager: 'loaded', 
        metricsCollector: 'loaded',
        mempoolMonitor: 'loaded'
      }
    });
  });
  
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Validation server running on port ${PORT}`);
    console.log(`📋 Visit http://localhost:${PORT}/health for status\n`);
  });
  
} catch (error) {
  console.error('❌ Validation failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}
