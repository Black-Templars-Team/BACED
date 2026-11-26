"use strict";

const fs = require("fs");
const path = require("path");

function dataDirectory() {
    const local = path.join(__dirname, "data");
    if (process.env.DAMAGE_SIM_DATA_DIR) return path.resolve(process.env.DAMAGE_SIM_DATA_DIR);
    if (fs.existsSync(path.join(local, "game_data.json"))) return local;

    // Linked worktrees do not inherit the main checkout's ignored generated data.
    const root = path.resolve(__dirname, "../..");
    try {
        const link = /^gitdir: (.+)$/.exec(fs.readFileSync(path.join(root, ".git"), "utf8").trim());
        if (!link) return local;
        const gitDir = path.resolve(root, link[1]);
        const commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
        const shared = path.resolve(commonDir, "../tools/damage_sim/data");
        if (fs.existsSync(path.join(shared, "game_data.json"))) return shared;
    } catch (err) {
        if (!["ENOENT", "ENOTDIR", "EISDIR"].includes(err.code)) throw err;
    }
    return local;
}

module.exports = dataDirectory;
