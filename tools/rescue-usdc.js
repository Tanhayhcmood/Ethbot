/**
 * Gasless USDC rescue (EIP-3009 transferWithAuthorization) - Ethereum MAINNET
 *
 * The stuck wallet (has USDC, NO ETH) only SIGNS an authorization (off-chain, free).
 * A second wallet (the RELAYER, has a little ETH) submits it and pays the gas.
 * USDC goes straight from the stuck wallet to SAFE_ADDRESS. The stuck wallet never needs ETH,
 * so there is nothing for any ETH-sweeper bot to catch.
 *
 * STOP the sweeper bot while you use this only if the RELAYER address == the bot's monitored wallet.
 *
 * Usage (from the project folder, after `npm install`):
 *   1) put the values in a file named .rescue.env  (never share it, delete it afterwards)
 *   2) DRY_RUN=true  node tools/rescue-usdc.js     -> checks everything, sends nothing
 *   3) DRY_RUN=false node tools/rescue-usdc.js     -> real transfer
 *
 * .rescue.env:
 *   RPC_URL=wss-or-https-mainnet-rpc
 *   STUCK_PRIVATE_KEY=0x...      # wallet that HOLDS the USDC (Trust Wallet account)
 *   RELAYER_PRIVATE_KEY=0x...    # a different wallet that holds a little ETH (about 0.002-0.005)
 *   SAFE_ADDRESS=0x...           # NEW wallet whose key only you control (receives the USDC)
 *   # optional:
 *   AMOUNT_USDC=                 # empty = full balance
 *   PRIORITY_FEE_GWEI=3
 *   SEND_RPC_URL=https://rpc.flashbots.net   # optional private relay for the final tx
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// tiny .rescue.env loader (no extra dependency)
const envFile = path.join(process.cwd(), '.rescue.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum mainnet
const ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)'
];

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name}`); process.exit(1); }
  return v;
}

(async () => {
  const dryRun = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';
  const provider = new ethers.JsonRpcProvider(need('RPC_URL'));
  const net = await provider.getNetwork();
  if (net.chainId !== 1n) { console.error('RPC is not Ethereum mainnet (chainId', net.chainId, ')'); process.exit(1); }

  const stuck = new ethers.Wallet(need('STUCK_PRIVATE_KEY'));
  const relayer = new ethers.Wallet(need('RELAYER_PRIVATE_KEY'), provider);
  const safe = ethers.getAddress(need('SAFE_ADDRESS'));
  if (safe.toLowerCase() === stuck.address.toLowerCase()) { console.error('SAFE_ADDRESS must be a different wallet from the stuck one'); process.exit(1); }

  const usdc = new ethers.Contract(USDC, ABI, relayer);
  const balance = await usdc.balanceOf(stuck.address);
  const value = process.env.AMOUNT_USDC ? ethers.parseUnits(process.env.AMOUNT_USDC, 6) : balance;
  if (value <= 0n || value > balance) { console.error('Nothing to move / amount > balance. Balance:', ethers.formatUnits(balance, 6)); process.exit(1); }

  console.log('Stuck wallet :', stuck.address);
  console.log('Relayer      :', relayer.address, '(ETH:', ethers.formatEther(await provider.getBalance(relayer.address)), ')');
  console.log('Safe wallet  :', safe);
  console.log('USDC to move :', ethers.formatUnits(value, 6), 'of', ethers.formatUnits(balance, 6));

  // --- sign the authorization (free, offline) ---
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // valid for 1 hour
  const domain = { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
    ]
  };
  const message = { from: stuck.address, to: safe, value, validAfter, validBefore, nonce };
  const sig = ethers.Signature.from(await stuck.signTypedData(domain, types, message));

  const args = [stuck.address, safe, value, validAfter, validBefore, nonce, sig.v, sig.r, sig.s];

  // --- simulate on the real chain: reverts here if domain/signature/balance is wrong ---
  await usdc.transferWithAuthorization.staticCall(...args);
  console.log('Simulation OK');

  const feeData = await provider.getFeeData();
  const tip = process.env.PRIORITY_FEE_GWEI ? ethers.parseUnits(process.env.PRIORITY_FEE_GWEI, 'gwei') : feeData.maxPriorityFeePerGas;
  const maxFee = (feeData.maxFeePerGas - feeData.maxPriorityFeePerGas) + tip;
  const gasLimit = ((await usdc.transferWithAuthorization.estimateGas(...args)) * 12n) / 10n;
  console.log('Max gas cost :', ethers.formatEther(gasLimit * maxFee), 'ETH (relayer pays)');

  if (dryRun) { console.log('\nDRY_RUN=true -> nothing was sent. Run again with DRY_RUN=false'); return; }

  const data = usdc.interface.encodeFunctionData('transferWithAuthorization', args);
  const raw = await relayer.signTransaction({
    to: USDC, data, value: 0n, gasLimit, chainId: 1n, type: 2,
    nonce: await provider.getTransactionCount(relayer.address, 'pending'),
    maxFeePerGas: maxFee, maxPriorityFeePerGas: tip
  });
  const sender = process.env.SEND_RPC_URL ? new ethers.JsonRpcProvider(process.env.SEND_RPC_URL) : provider;
  const hash = await sender.send('eth_sendRawTransaction', [raw]);
  console.log('Sent:', hash);
  const receipt = await provider.waitForTransaction(hash, 1, 180000);
  console.log(receipt && receipt.status === 1 ? '✅ USDC moved to the safe wallet' : '❌ failed or not confirmed yet - check the hash on etherscan');
})().catch(e => { console.error('ERROR:', e.shortMessage || e.message); process.exit(1); });
