const dfs = require('@defisaver/sdk');
let { utils: { curveUtils: { poolInfo } } } = require('@defisaver/sdk');
const { expect } = require('chai');
const hre = require('hardhat');

const {
    balanceOf,
    getProxy,
    redeploy,
    approve,
    WETH_ADDRESS,
    setBalance,
    Float2BN,
    resetForkToBlock,
    setNetwork,
    getContractFromRegistry,
    ETH_ADDR,
} = require('../utils/utils');

const {
    curveDeposit,
    curveWithdraw,
} = require('../utils/actions');

// Align with existing curve-tests.js
const forkNum = 17020442;

// Helper to normalize ETH->WETH for balance checks
const normalizeTokenAddr = (addr) => (addr === ETH_ADDR ? WETH_ADDRESS : addr);

// The PoC targets: removeOneCoin=false, withdrawExact=false, explicitUnderlying=true,
// and amounts = [0, 0, 0...] on a pool that returns all coins pro-rata (e.g. 3pool underlying via zap)
describe('Curve-Withdraw-Bug-PoC', function () {
    this.timeout(1_000_000);

    let senderAcc;
    let senderAddr;
    let proxy;

    before(async () => {
        setNetwork('mainnet');
        await resetForkToBlock(forkNum);

        senderAcc = (await hre.ethers.getSigners())[0];
        senderAddr = senderAcc.address;
        proxy = await getProxy(senderAcc.address);

        await redeploy('CurveDeposit');
        await redeploy('CurveWithdraw');

        // Narrow poolInfo to find 3pool by name (case-insensitive)
        const lowered = (s) => (s || '').toString().toLowerCase();
        // eslint-disable-next-line prefer-destructuring
        poolInfo = poolInfo.filter(({ name }) => lowered(name) !== 'aave');
        const target = poolInfo.find(({ name }) => lowered(name).includes('3pool'));
        if (!target) {
            // Fallback: try to find a 3-coin stable pool with underlying coins (DAI/USDC/USDT)
            poolInfo = poolInfo.filter((p) => Array.isArray(p.underlyingCoins) && p.underlyingCoins.length === 3);
        }
    });

    it('should strand non-first coins on CurveWithdraw contract with zero minimums (3pool underlying)', async function () {
        // Locate 3pool; if not present, attempt best-effort pick of a 3-coin stable underlying pool
        const toLower = (s) => (s || '').toString().toLowerCase();
        const threePool = poolInfo.find(({ name }) => toLower(name).includes('3pool'))
            || poolInfo.find((p) => Array.isArray(p.underlyingCoins) && p.underlyingCoins.length === 3);

        if (!threePool) this.skip();

        const pool = threePool;
        const amountEach = '1000';

        // Prepare underlying deposit balances and approvals
        const depositAmts = pool.underlyingDecimals.map((d) => Float2BN(amountEach, d));
        await Promise.all(pool.underlyingCoins.map(async (c, i) => {
            // eslint-disable-next-line no-param-reassign
            if (c === ETH_ADDR) c = WETH_ADDRESS;
            await setBalance(c, senderAddr, depositAmts[i]);
            await approve(c, proxy.address);
        }));

        // Ensure LP balance starts at 0
        const lpBefore = await balanceOf(pool.lpToken, senderAddr);
        expect(lpBefore).to.eq('0');

        // Deposit underlying -> mint LP
        await curveDeposit(
            proxy,
            senderAddr,
            senderAddr,
            pool.swapAddr,
            '0', // minMintAmount
            true, // useUnderlying
            depositAmts,
        );
        const lpAfter = await balanceOf(pool.lpToken, senderAddr);
        expect(lpAfter).to.be.gt('0');

        // Record receiver balances before withdraw
        const recvBefore = await Promise.all(
            pool.underlyingCoins.map(async (c) => balanceOf(normalizeTokenAddr(c), senderAddr)),
        );

        // Withdraw with zero minimums, remove_liquidity path
        const zeroAmts = pool.underlyingDecimals.map((d) => Float2BN('0', d));
        await approve(pool.lpToken, proxy.address);
        await curveWithdraw(
            proxy,
            senderAddr,
            senderAddr,
            pool.swapAddr,
            lpAfter,       // burnAmount
            true,          // useUnderlying (explicitUnderlying)
            false,         // withdrawExact (imbalance) -> false
            false,         // removeOneCoin -> false
            zeroAmts,
        );

        // Compute deltas for receiver
        const recvAfter = await Promise.all(
            pool.underlyingCoins.map(async (c) => balanceOf(normalizeTokenAddr(c), senderAddr)),
        );
        const recvDelta = recvAfter.map((v, i) => v.sub(recvBefore[i]));

        // Expect only the first coin to be forwarded due to the bug
        expect(recvDelta[0]).to.be.gt('0');
        for (let i = 1; i < recvDelta.length; i++) {
            expect(recvDelta[i]).to.eq(0);
        }

        // Check that the non-first coins remain stuck on the CurveWithdraw action contract
        const withdrawAction = await getContractFromRegistry('CurveWithdraw');
        const actionAddr = withdrawAction.address;

        const actionBalances = await Promise.all(
            pool.underlyingCoins.map(async (c) => balanceOf(normalizeTokenAddr(c), actionAddr)),
        );

        // First coin should not remain; others should be > 0 (stuck balances)
        expect(actionBalances[0]).to.eq('0');
        for (let i = 1; i < actionBalances.length; i++) {
            expect(actionBalances[i]).to.be.gt('0');
        }
    });
});
