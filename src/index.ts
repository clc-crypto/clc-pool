import express from "express";
import cors from "cors";
import { ec } from "elliptic";
import crypto from "crypto";
import fs from "fs";
import https from "https";

const useHttps = true;

function cutNumber(num: number) {
    const str = num.toString();
    const index = str.indexOf('.');
    if (index === -1) return 0; // no decimal, return as is
    return parseFloat(str.slice(0, index + 8));
}

function sha256(input: string) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

const ecdsa = new ec('secp256k1');

const app = express();
const port = 6066;
const challengeRefresh = 2000;
const server = "https://clc.ix.tc";
const poolDiff = "000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
const fee = 0.02;
const feeCoinId = 0;

app.use(cors()); // Cors all origins

let challenge = {};

async function updateChallenge() {
    const resp = await fetch(server + "/get-challenge");
    const netJob = await resp.json();
    netJob.diff = poolDiff;
    challenge = netJob;
}

setInterval(async () => await updateChallenge(), challengeRefresh);
updateChallenge();

app.get("/get-challenge", async (_, res) => {
    try {
        res.json(challenge);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

let contributors: Record<string, number> = {};
let rewards: Record<number, Record<string, number>> = {};
if (fs.existsSync("./rewards.json")) rewards = JSON.parse(fs.readFileSync("./rewards.json", "utf-8"));
let mined: Record<number, string> = {};
if (fs.existsSync("./mined.json")) mined = JSON.parse(fs.readFileSync("./mined.json", "utf-8"));
let usedHashes: string[] = [];

function save() {
    fs.writeFileSync("./rewards.json", JSON.stringify(rewards, null, 4));
    fs.writeFileSync("./mined.json", JSON.stringify(mined, null, 4));
}

async function splitRewards(holder: string, miningSignature: string, minedHash: string, coinPrivate: string) {
    try {
        const key = ecdsa.keyFromPrivate(coinPrivate, "hex");

        // submit coin to proxy
        const subRes = await (await fetch(server + "/challenge-solved?holder=" + holder + "&sign=" + miningSignature + "&hash=" + minedHash)).json();
        const id = subRes.id as number;
        if (id === null || id === undefined) throw new Error("Server did not properly respond to challenge-solved: " + JSON.stringify(subRes));
    
        const coin = (await (await fetch(server + "/coin/" + id)).json()).coin;
        console.log(`Pool just mined coin, worth: ${coin.val}CLC`);
    
        // Pay dev fees + take pool fee
        const devCoin = (await (await fetch(server + "/coin/" + feeCoinId)).json()).coin;
        const devFeeMsg = feeCoinId + " " + devCoin.transactions.length + " " + (coin.val * (0.021 + fee));
        const devFeeSign = key.sign(sha256(devFeeMsg)).toDER('hex');
        const devFeesUrl = server + `/merge?origin=${id}&target=${feeCoinId}&vol=${coin.val * (0.021 + fee)}&sign=${devFeeSign}`;
        const feeRes = await (await fetch(devFeesUrl)).json();
        if (feeRes.message !== "success") throw new Error("Error paying dev fees " + JSON.stringify(feeRes));
    
        // Calculate rewards based on contributions
        const coinAfterFees = (await (await fetch(server + "/coin/" + id)).json()).coin;
        rewards[id] = {};
        let contributionsCount = 0;
        for (const contributor in contributors) {
            contributionsCount += contributors[contributor];
        }
    
        console.log(contributionsCount + " miners contributed")
        const shareInCLC = coinAfterFees.val / contributionsCount;
        console.log("Contributions: " + JSON.stringify(contributors));
        for (const contributor in contributors) {
            rewards[id][contributor] = contributors[contributor] * shareInCLC;
        }
    
        mined[id] = coinPrivate;
        save();
    } catch (e: any) {
        console.log(e.message);
        throw e;
    }
}

app.get("/payouts/:poolsecret", async (req, res) => {
    try {
        const poolSecret = req.params.poolsecret;

        const result: number[] = [];
        for (const cid in rewards) {
            if (rewards[cid][poolSecret]) result.push(Number(cid));
        }
        res.json(result);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/total/:poolsecret", async (req, res) => {
    try {
        const poolSecret = req.params.poolsecret;

        let result: number = 0;
        for (const cid in rewards) {
            if (rewards[cid][poolSecret]) result += rewards[cid][poolSecret];
        }
        res.json({ total: result });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

async function splitOffReward(id: number, poolSecret: string) {
    const key = ecdsa.keyFromPrivate(mined[id], "hex");
    const minedCoin = (await (await fetch(server + "/coin/" + id)).json()).coin;

    // Get ledger length
    const splitId = (await (await fetch(server + "/ledger-length")).json()).length + 1;
    const splitMsg = splitId + " 1 " + cutNumber(Math.min(rewards[id][poolSecret], minedCoin.val));
    console.log("Amnt: " + minedCoin.val);
    const splitSign = key.sign(sha256(splitMsg)).toDER('hex');
    const splitUrl = server + `/split?origin=${id}&target=${splitId}&vol=${cutNumber(Math.min(rewards[id][poolSecret], minedCoin.val))}&sign=${splitSign}`;
    const splitRes = await (await fetch(splitUrl)).json();
    if (splitRes.message !== "success") throw new Error("Error splitting coin #" + id + ", " + splitRes.error);

    return splitId;
}

async function splitOffAndMergeReward(id: number, targetId: number, poolSecret: string) {
    const key = ecdsa.keyFromPrivate(mined[id], "hex");
    const minedCoin = (await (await fetch(server + "/coin/" + id)).json()).coin;

    // Get ledger length
    const target = (await (await fetch(server + "/coin/" + targetId)).json()).coin;
    const mergeCoinMsg = targetId + " " + target.transactions.length + " " + cutNumber(Math.min(rewards[id][poolSecret], minedCoin.val));
    console.log("Mrg msg " + mergeCoinMsg);
    const mergeCoinSign = key.sign(sha256(mergeCoinMsg)).toDER('hex');
    const mergeCoinUrl = server + `/merge?origin=${id}&target=${targetId}&vol=${cutNumber(Math.min(rewards[id][poolSecret], minedCoin.val))}&sign=${mergeCoinSign}`;
    const mergeRes = await (await fetch(mergeCoinUrl)).json();

    if (mergeRes.message !== "success") throw new Error("Error merging coin " + JSON.stringify(mergeRes));
}

app.get("/payout/:poolsecret", async (req, res) => {
    try {
        const poolSecret = req.params.poolsecret as string;
        const addr = req.query.addr as string;

        if (!addr) throw new Error("addr query param not provided");

        let rewardId: number = -1;
        let key: null | ec.KeyPair = null;
        for (const minedId in mined) {
            if (!rewards[minedId][poolSecret]) continue;
            if (rewardId !== -1) {
                await splitOffAndMergeReward(parseInt(minedId), rewardId, poolSecret);
            } else {
                key = ecdsa.keyFromPrivate(mined[minedId]);
                rewardId = await splitOffReward(parseInt(minedId), poolSecret);
            }
            delete rewards[minedId][poolSecret];
            save();
        }

        if (rewardId === -1 || key === null) throw new Error("Already paid out your rewards, or you have not yet mined any.");

        const transSign = key.sign(sha256(addr)).toDER("hex");
        const transUrl = server + `/transaction?cid=${rewardId}&sign=${transSign}&newholder=${addr}`;
        const transRes = await (await fetch(transUrl)).json();
        if (transRes.message !== "success") throw new Error("Error transacting coin #" + rewardId + ", " + transRes.error);
        save();
        
        res.json({ id: rewardId });
    } catch(e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/challenge-solved", async (req, res) => {
    try {
        const holder = req.query.holder as string;
        const miningSignature = req.query.sign as string;
        const minedHash = req.query.hash as string;
        const poolSecret = req.query.poolsecret as string;
        const coinPrivate = req.query.key as string;
        
        const netJob = await (await fetch(server + "/get-challenge")).json();
        console.log(holder);
        const key = ecdsa.keyFromPublic(holder, 'hex');
        if (ecdsa.keyFromPrivate(coinPrivate, "hex").getPublic().encode("hex", false) !== req.query.holder) throw new Error("Invlaid secret key");
        if (!key.verify(sha256(holder), miningSignature) && miningSignature !== "split") throw new Error("Invalid mining signature.");
        if (BigInt("0x" + poolDiff) < BigInt("0x" + minedHash)) throw new Error("Mined hash does not meet difficulty criteria.");
        if (sha256(key.getPublic().encode("hex", false) + netJob.seed) !== minedHash) throw new Error("Invalid mined hash.");
        if (usedHashes.includes(minedHash)) throw new Error("This hash has already been submitted!");
        console.log("0x" + netJob.diff + " | 0x" + minedHash)
        if (!contributors[poolSecret]) contributors[poolSecret] = 0;
        contributors[poolSecret]++;
        usedHashes.push(minedHash);
        if (BigInt("0x" + netJob.diff) > BigInt("0x" + minedHash)) { // Mined a coin
            console.log("Mined!");
            await splitRewards(holder, miningSignature, minedHash, coinPrivate);
            contributors = {};
            usedHashes = [];
            return;
        }
        save();

        res.json({ message: "success" });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

if (useHttps) {
    const privateKey = fs.readFileSync('/etc/letsencrypt/live/clc.ix.tc/privkey.pem', 'utf8');
    const certificate = fs.readFileSync('/etc/letsencrypt/live/clc.ix.tc/fullchain.pem', 'utf8');
    const credentials = { key: privateKey, cert: certificate };

    https.createServer(credentials, app).listen(port, () => {
        console.log(`HTTPS server running at https://localhost:${port}`);
    });
} else {
    app.listen(port, () => {
        console.log(`HTTP server running at http://localhost:${port}`);
    });
}
