/**
 * Token Registry - ERC20 Token Definitions
 * 
 * Contains contract addresses and ABIs for supported tokens:
 * - ETH (Native)
 * - USDT (Tether USD - ERC20)
 * - USDC (USD Coin - ERC20)
 * 
 * This module is an EXTENSION - does NOT modify existing code
 */

const SUPPORTED_TOKENS = {
  ETH: {
    symbol: 'ETH',
    name: 'Ethereum',
    decimals: 18,
    isNative: true,
    contractAddress: null
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    isNative: false,
    contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    isNative: false,
    contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  }
};

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
];

const ERC20_TRANSFER_EVENT_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function getTokenByAddress(address) {
  if (!address) return SUPPORTED_TOKENS.ETH;
  
  const normalizedAddress = address.toLowerCase();
  
  for (const [symbol, token] of Object.entries(SUPPORTED_TOKENS)) {
    if (token.contractAddress && token.contractAddress.toLowerCase() === normalizedAddress) {
      return { ...token, symbol };
    }
  }
  
  return null;
}

function getTokenBySymbol(symbol) {
  const upperSymbol = symbol.toUpperCase();
  return SUPPORTED_TOKENS[upperSymbol] || null;
}

function getAllSupportedTokenAddresses() {
  return Object.values(SUPPORTED_TOKENS)
    .filter(token => !token.isNative && token.contractAddress)
    .map(token => token.contractAddress.toLowerCase());
}

function formatTokenAmount(amount, decimals) {
  const divisor = BigInt(10 ** decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;
  
  if (fractionalPart === 0n) {
    return integerPart.toString();
  }
  
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const trimmedFractional = fractionalStr.replace(/0+$/, '');
  
  return `${integerPart}.${trimmedFractional}`;
}

function parseTokenAmount(amountStr, decimals) {
  const parts = amountStr.split('.');
  const integerPart = parts[0] || '0';
  let fractionalPart = parts[1] || '';
  
  fractionalPart = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
  
  return BigInt(integerPart + fractionalPart);
}

module.exports = {
  SUPPORTED_TOKENS,
  ERC20_ABI,
  ERC20_TRANSFER_EVENT_SIGNATURE,
  getTokenByAddress,
  getTokenBySymbol,
  getAllSupportedTokenAddresses,
  formatTokenAmount,
  parseTokenAmount
};
