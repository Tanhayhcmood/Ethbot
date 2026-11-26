/**
 * Fee Switcher Module - Entry Point
 * 
 * Trust Wallet FlexGas Style Auto Fee Switching
 * 
 * Features:
 * - Automatic detection of incoming deposits (ETH, USDT, USDC)
 * - Sub-second detection speed
 * - Automatic token type identification
 * - Full token transfer to destination wallet
 * - Dynamic gas estimation
 * - Comprehensive logging
 * 
 * This module is an EXTENSION - does NOT modify existing code
 */

const AutoFeeTokenSwitcher = require('./auto_fee_token');
const DepositListener = require('./deposit_listener');
const ERC20Executor = require('./erc20_executor');
const tokenRegistry = require('./token_registry');
const integration = require('./integration');

module.exports = {
  AutoFeeTokenSwitcher,
  DepositListener,
  ERC20Executor,
  tokenRegistry,
  ...integration
};
