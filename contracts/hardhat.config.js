require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-ethers");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Compile with the solc-js build pinned in package.json (works offline, reproducible).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion !== "0.8.24") return runSuper();
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: require("solc").version() };
});

const key = process.env.DEPLOYER_PRIVATE_KEY;
module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" } },
  paths: { sources: process.env.WITH_TEST_CONTRACTS ? "./all-sources" : "./src" },
  networks: {
    polygon: { url: process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com", chainId: 137, accounts: key ? [key] : [] },
  },
};
