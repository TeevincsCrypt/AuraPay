const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
const warp = async (s) => { await network.provider.send("evm_increaseTime", [s]); await network.provider.send("evm_mine"); };

describe("AuraPaySavingsVault", () => {
  let vault, usdt, owner, other, relayer;
  beforeEach(async () => {
    [owner, other, relayer] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("AuraPaySavingsVault")).deploy();
    usdt = await (await ethers.getContractFactory("MockToken")).deploy();
    await usdt.mint(owner.address, 100_000_000n);
    await usdt.approve(await vault.getAddress(), 100_000_000n);
  });

  it("locks, refuses early release, then pays the owner whoever releases", async () => {
    const unlockAt = (await now()) + 3600;
    await expect(vault.lock(await usdt.getAddress(), 10_000_000n, unlockAt))
      .to.emit(vault, "Locked").withArgs(0, owner.address, await usdt.getAddress(), 10_000_000n, unlockAt);
    expect(await usdt.balanceOf(await vault.getAddress())).to.equal(10_000_000n);
    await expect(vault.release(0)).to.be.revertedWithCustomError(vault, "StillLocked");
    await expect(vault.connect(other).release(0)).to.be.revertedWithCustomError(vault, "StillLocked");
    await warp(3600);
    const before = await usdt.balanceOf(owner.address);
    await expect(vault.connect(relayer).release(0)).to.emit(vault, "Released").withArgs(0, owner.address, await usdt.getAddress(), 10_000_000n, relayer.address);
    expect(await usdt.balanceOf(owner.address)).to.equal(before + 10_000_000n);
    expect(await usdt.balanceOf(relayer.address)).to.equal(0n);
    await expect(vault.release(0)).to.be.revertedWithCustomError(vault, "AlreadyReleased");
    expect((await vault.getLock(0)).released).to.equal(true);
  });

  it("validates amount, unlock time and ids", async () => {
    const t = await usdt.getAddress();
    await expect(vault.lock(t, 0, (await now()) + 60)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.lock(t, 1, await now())).to.be.revertedWithCustomError(vault, "InvalidUnlockTime");
    await expect(vault.lock(t, 1, (await now()) + 3651 * 86400)).to.be.revertedWithCustomError(vault, "InvalidUnlockTime");
    await expect(vault.release(5)).to.be.revertedWithCustomError(vault, "UnknownLock");
    await expect(vault.connect(other).lock(t, 1, (await now()) + 60)).to.be.revertedWithCustomError(vault, "TokenTransferFailed");
    await expect(vault.lock(other.address, 1, (await now()) + 60)).to.be.revertedWithCustomError(vault, "TokenTransferFailed"); // not a contract
  });

  it("keeps locks separate per owner", async () => {
    const t = await usdt.getAddress();
    await usdt.mint(other.address, 5_000_000n);
    await usdt.connect(other).approve(await vault.getAddress(), 5_000_000n);
    const at = (await now()) + 100;
    await vault.lock(t, 7_000_000n, at);
    await vault.connect(other).lock(t, 5_000_000n, at + 1000);
    await warp(200);
    await vault.connect(other).release(0); // other can trigger owner's release, funds go to owner
    expect(await usdt.balanceOf(other.address)).to.equal(0n);
    await expect(vault.release(1)).to.be.revertedWithCustomError(vault, "StillLocked");
    expect(await vault.lockCount()).to.equal(2n);
  });

  it("credits only what arrived for fee-on-transfer tokens", async () => {
    const fee = await (await ethers.getContractFactory("FeeToken")).deploy();
    await fee.mint(owner.address, 1000n);
    await fee.approve(await vault.getAddress(), 1000n);
    await vault.lock(await fee.getAddress(), 1000n, (await now()) + 60);
    expect((await vault.getLock(0)).amount).to.equal(990n);
  });

  it("blocks re-entrancy during release", async () => {
    const r = await (await ethers.getContractFactory("ReentrantToken")).deploy();
    await r.mint(owner.address, 1000n);
    await r.approve(await vault.getAddress(), 1000n);
    await vault.lock(await r.getAddress(), 1000n, (await now()) + 60);
    await r.arm(await vault.getAddress(), 0);
    await warp(120);
    await vault.release(0);
    expect(await r.tried()).to.equal(true);
    expect(await r.balanceOf(owner.address)).to.equal(1000n); // paid exactly once
  });
});
