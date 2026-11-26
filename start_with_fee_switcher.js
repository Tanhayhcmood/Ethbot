/**
 * Extended Startup Script with Auto Fee Token Switcher
 * 
 * This script starts the original bot AND the new auto fee switching module.
 * It does NOT modify the existing bot.js - it extends its functionality.
 * 
 * Usage: node start_with_fee_switcher.js
 */

require('dotenv').config();
const { ethers } = require('ethers');

const { initializeAutoFeeSwitcher, stopAutoFeeSwitcher } = require('./fee_switcher');

let autoFeeSwitcher = null;

async function startAutoFeeSwitcherExtension() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🔥 AUTO FEE TOKEN SWITCHER EXTENSION - Trust Wallet FlexGas Style');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const DESTINATION_ADDRESS = process.env.DESTINATION_ADDRESS;
  
  const RPC_URLS = [
    process.env.RPC_URL_PRIMARY || process.env.RPC_URL,
    process.env.RPC_URL_SECONDARY,
    process.env.RPC_URL_TERTIARY
  ].filter(Boolean);
  
  if (!PRIVATE_KEY) {
    console.error('❌ PRIVATE_KEY is required');
    process.exit(1);
  }
  
  if (!DESTINATION_ADDRESS) {
    console.error('❌ DESTINATION_ADDRESS is required');
    process.exit(1);
  }
  
  if (RPC_URLS.length === 0) {
    console.error('❌ At least one RPC URL is required');
    process.exit(1);
  }
  
  console.log('📋 Configuration:');
  console.log(`   - RPC endpoints: ${RPC_URLS.length}`);
  console.log(`   - Destination: ${DESTINATION_ADDRESS.slice(0, 6)}...${DESTINATION_ADDRESS.slice(-4)}`);
  console.log('');
  
  let provider;
  
  for (const rpcUrl of RPC_URLS) {
    try {
      console.log(`🔌 Connecting to RPC: ${rpcUrl.substring(0, 30)}...`);
      
      if (rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')) {
        provider = new ethers.WebSocketProvider(rpcUrl);
      } else {
        provider = new ethers.JsonRpcProvider(rpcUrl);
      }
      
      await provider.getBlockNumber();
      console.log('✅ RPC connection successful\n');
      break;
      
    } catch (error) {
      console.error(`⚠️ RPC connection failed: ${error.message}`);
      provider = null;
    }
  }
  
  if (!provider) {
    console.error('❌ Failed to connect to any RPC endpoint');
    process.exit(1);
  }
  
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const monitoredAddress = wallet.address;
  
  console.log(`📍 Monitored Address: ${monitoredAddress.slice(0, 6)}...${monitoredAddress.slice(-4)}`);
  console.log('');
  
  try {
    autoFeeSwitcher = await initializeAutoFeeSwitcher({
      privateKey: PRIVATE_KEY,
      destinationAddress: DESTINATION_ADDRESS,
      provider: provider,
      monitoredAddress: monitoredAddress,
      telegramNotifier: null
    });
    
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ AUTO FEE SWITCHER IS NOW ACTIVE');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('📌 Supported Tokens: ETH, USDT (ERC20), USDC (ERC20)');
    console.log('⚡ Detection Speed: < 1 second');
    console.log('');
    console.log('📝 What happens when a deposit is detected:');
    console.log('   1. Token type is automatically identified');
    console.log('   2. Fee token is switched to match deposit');
    console.log('   3. 100% of tokens are transferred to Wallet B');
    console.log('   4. Transaction logged and confirmed');
    console.log('');
    console.log('⏳ Waiting for deposits...\n');
    
  } catch (error) {
    console.error('❌ Failed to start Auto Fee Switcher:', error.message);
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal} - Shutting down Auto Fee Switcher...`);
  
  try {
    if (autoFeeSwitcher) {
      await stopAutoFeeSwitcher();
    }
    console.log('✅ Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('⚠️ Uncaught Exception:', error.message);
});

startAutoFeeSwitcherExtension().catch(error => {
  console.error('❌ Fatal error:', error.message);
  process.exit(1);
});
