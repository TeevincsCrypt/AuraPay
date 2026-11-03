// Deploys AuraPaySavingsVault to Polygon with DEPLOYER_PRIVATE_KEY (any wallet holding ~0.1 POL).
// The deployer gets no special rights: the contract has no owner.
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("Set DEPLOYER_PRIVATE_KEY (a wallet with a little POL for gas).");
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId !== 137n) throw new Error(`Expected Polygon (137), got chain ${chainId}.`);
  console.log(`Deploying from ${deployer.address}…`);
  const vault = await hre.ethers.deployContract("AuraPaySavingsVault");
  await vault.waitForDeployment();
  const address = await vault.getAddress();
  console.log(`\nAuraPaySavingsVault: ${address}`);
  console.log(`Polygonscan: https://polygonscan.com/address/${address}`);
  console.log(`\nSet SAVINGS_VAULT_ADDRESS=${address} in Vercel, then redeploy.`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
