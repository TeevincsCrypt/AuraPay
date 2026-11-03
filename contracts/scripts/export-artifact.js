// Writes the ABI + bytecode the app and the deploy script use (contracts/AuraPaySavingsVault.json).
const fs = require("fs");
const path = require("path");
const a = require("../artifacts/src/AuraPaySavingsVault.sol/AuraPaySavingsVault.json");
const out = { contractName: a.contractName, compiler: "solc 0.8.24, optimizer 200 runs, evmVersion paris", abi: a.abi, bytecode: a.bytecode };
fs.writeFileSync(path.join(__dirname, "..", "AuraPaySavingsVault.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote contracts/AuraPaySavingsVault.json");
