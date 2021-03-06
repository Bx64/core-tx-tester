const { Crypto, Enums, Utils, Managers, Transactions, Identities } = require("@arkecosystem/crypto");

const MagistrateCrypto = require("@arkecosystem/core-magistrate-crypto");

const { httpie } = require("@arkecosystem/core-utils");
const assert = require("assert");

/**
 * $ node index.js
 * Ѧ 0      ENTER - send a transfer
 * Ѧ 0 10   ENTER - send 10 transfers
 *
 * Specifics for entity transactions :
 * $ node index.js
 *
 * Ѧ 11 1 1 1 register my_business QmV1n5F9PuBE2ovW9jVfFpxyvWZxYHjSdfLrYL2nDcb1gW
 * ENTER - send a register entity for business with name and ipfs hash
 *
 * Ѧ 11 1 1 1 update 521b65c4f1f08716f9cc70f3a0c4d1ea5899f35a122d238b2114eed8161c0d5f QmV1n5F9PuBE2ovW9jVfFpxyvWZxYHjSdfLrYL2nDcb1gW
 * ENTER - send a update entity for plugin-core with associated registration id and updated ipfs hash
 *
 * Ѧ 11 1 1 1 resign 521b65c4f1f08716f9cc70f3a0c4d1ea5899f35a122d238b2114eed8161c0d5f
 * ENTER - send a resign entity for plugin-core with associated registration id
 *
 * CTRL-C to exit.
 * Use config below to tweak script and make it deterministic.
 *
 * TIPS:
 *
 * Once V2 milestone is active:
 * If you get nonce errors, try restarting the script first. It caches the
 * nonces and always increments for each sent transaction even if it ends up getting rejected.
 *
 * - At the bottom of this file are `testWallets` each with a balance of 475 DARK.
 * - If you encounter an error, just CTRL-C and restart.

 * Types:
 * 0 - Transfer
 * 1 - SecondSignature
 * 2 - DelegateRegistration
 * 3 - Vote
 * 4 - MultiSignature
 * 5 - IPFS
 * 6 - MultiPayment
 * 7 - DelegateResignation
 * 8 - HTLC Lock
 * 9 - HTLC Claim
 * 10 - HTLC Refund
 *
 * (These types are actually wrong and only used in this script to keep things simple)
 * 11 - Entity
 *
 * Multisignature:
 * - First register a new multisig wallet (address is derived from the asset `participants` and `min`)
 * - The script will print the new multisig wallet address
 * - After creation send funds to this wallet, set `recipientId` in this script
 * - Finally, `enable` the multisignature by setting it to `true` in the config, do not change the asset at this point
 *   since it is used to derive the address
 * - All outgoing transactions will now be multi signed with the configured `passphrases`
 * - Remove passphrases and change indexes to test `min` etc.
 */
const config = {
    // log sent transaction payload
    verbose: true,
    // defaults to random genesis seed node
    peer: undefined,
    // defaults to schnorr signatures if aip11 milestone is active, otherwise has no effect
    ecdsa: false,
    // defaults to a random passphrase
    passphrase: undefined,
    // disable transaction broadcast
    coldrun: false,
    // defaults to a random recipient
    recipientId: undefined,
    // default is retrieved from API
    startNonce: undefined,
    // default is no expiration, only valid for transfer. expiration is by block height
    expiration: undefined,
    // amount for transfer and htlc lock
    amount: "1",
    // defaults to static fee
    fee: undefined,
    // defaults to a random vendor field or value if set
    vendorField: {
        value: undefined,
        random: true,
    },
    // used to create second signature
    secondPassphrase: undefined,
    // delegate name, defaults to slice of sender public key
    delegateName: undefined,
    // vote/unvote defaults to slice of sender public key ^
    vote: undefined,
    unvote: undefined,
    // multi signature configuration
    multiSignature: {
        // If enabled, all transactions will be made from the multisig wallet that is derived
        // from the configured `asset`
        enabled: false,
        asset: {
            // passphrase of each participant
            participants: [
                "multisig participant 1",
                "multisig participant 2",
                "multisig participant 3",
            ],
            // mandatory signatures
            min: 2,
        },

        // Use the following passphrases to sign a multisignature transaction for the configured `asset`
        // if `enabled` is true:
        passphrases: [
            { index: 0, passphrase: "multisig participant 1" },
            { index: 1, passphrase: "multisig participant 2" },
            { index: 2, passphrase: "multisig participant 3" }
        ]
    },
    // ipfs
    ipfs: "QmYSK2JyM3RyDyB52caZCTKFR3HKniEcMnNJYdk8DQ6KKB",
    // multi payment defaults to 64-128 payments to specific recipients
    multiPayments: [
        // { recipientId: "recipient2", amount: "1"},
        // { recipientId: "recipient1", amount: "1"},
    ],
    htlc: {
        lock: {
            // sha256 of secret
            secretHash: Crypto.HashAlgorithms.sha256(
                Crypto.HashAlgorithms.sha256("htlc secret").toString("hex").slice(0, 32)
            ).toString("hex"),
            expiration: {
                // 1=EpochTimestamp, 2=BlockHeight
                type: 1,
                // expiration in seconds relative to network time (this scripts reads the network time)
                // if height then use absolute height
                value: 52 * 8, // Lock expires after approx. 1 round
            },
        },
        claim: {
            // by default it tries to retrieve the last lock transaction id from given sender via API
            lockTransactionId: undefined,
            // same as used for the htlc lock
            unlockSecret: Crypto.HashAlgorithms.sha256("htlc secret").toString("hex").slice(0, 32)
        },
        refund: {
            // by default it tries to retrieve the last lock transaction id from given sender via API
            lockTransactionId: undefined,
        }
    },
}

const configureCrypto = async () => {
    Managers.configManager.setFromPreset("devnet");

    try {
        const response = await httpie.get(`http://${randomSeed()}:4003/api/blockchain`);

        Managers.configManager.setHeight(response.body.data.block.height)
    } catch (ex) {
        console.log("configureCrypto: " + ex.message);
        process.exit()
    }
}

const prompt = (question, callback) => {
    const stdin = process.stdin;
    const stdout = process.stdout

    stdin.resume();
    stdout.write(question);

    stdin.once('data', (data) => {
        callback(data.toString().trim());
    });
}

const nonces = {}

const main = async (data) => {
    try {
        await configureCrypto();

        const splitInput = data.split(" ");
        let [type, quantity] = splitInput;

        type = +type;
        quantity = quantity || 1;

        const builder = builders[type];
        if (!builder) {
            throw new Error("Unknown type");
        }

        const senderSecret = config.passphrase || testWallets[Math.floor(Math.random()*testWallets.length)].passphrase;
        const recipientSecret = testWallets[Math.floor(Math.random()*testWallets.length)].passphrase;

        const senderKeys = Identities.Keys.fromPassphrase(senderSecret);
        const recipientId = config.recipientId || Identities.Address.fromPassphrase(recipientSecret);

        const senderWallet = await retrieveSenderWallet(Identities.Address.fromPublicKey(senderKeys.publicKey));
        if (!senderWallet.publicKey) {
            senderWallet.publicKey = senderKeys.publicKey;
        }

        const transactions = [];

        for (let i = 0; i < quantity; i++) {
            let nonce = nonces[senderKeys.publicKey];
            if (!nonce) {
                let senderNonce = senderWallet.nonce;
                if (config.multiSignature.enabled) {
                    senderNonce = (await retrieveSenderWallet(multiSignatureAddress().address)).nonce;
                }

                nonce = Utils.BigNumber.make(config.startNonce || senderNonce || 0).plus(1);
            } else {
                nonce = nonce.plus(1);
            }
            nonces[senderKeys.publicKey] = nonce;

            const transaction = builder()
                .nonce(nonce.toFixed())
                .senderPublicKey(senderKeys.publicKey);

            if (config.fee) {
                transaction.fee(config.fee)
            }

            if (type === Enums.TransactionType.Transfer) {
                transaction.recipientId(recipientId)
                transaction.amount(config.amount);
                transaction.expiration(config.expiration || 0);

            } else if (type === Enums.TransactionType.SecondSignature) {
                const secondPassphrase = config.secondPassphrase || "second passphrase";
                transaction.signatureAsset(secondPassphrase);

            } else if (type === Enums.TransactionType.DelegateRegistration) {
                const username = config.delegateName || `delegate.${senderKeys.publicKey.slice(0, 10)}`;
                transaction.usernameAsset(username);

            } else if (type === Enums.TransactionType.Vote) {
                if (config.vote) {
                    transaction.votesAsset([`+${config.vote}`]);
                } else if (config.unvote) {
                    transaction.votesAsset([`-${config.unvote}`]);
                } else {
                    if (senderWallet.vote) {
                        transaction.votesAsset([`-${senderWallet.vote}`])
                    } else {
                        transaction.votesAsset([`+${senderKeys.publicKey}`])
                    }
                }

            } else if (type === Enums.TransactionType.MultiSignature && Managers.configManager.getMilestone().aip11) {
                for (const passphrase of config.multiSignature.asset.participants) {
                    transaction.participant(Identities.PublicKey.fromPassphrase(passphrase));
                }

                transaction.min(config.multiSignature.asset.min)

            } else if (type === Enums.TransactionType.Ipfs && Managers.configManager.getMilestone().aip11) {
                transaction.ipfsAsset(config.ipfs)

            } else if (type === Enums.TransactionType.MultiPayment && Managers.configManager.getMilestone().aip11) {

                let payments;
                if (!config.multiPayments || config.multiPayments.length === 0) {
                    payments = [];
                    const count = Math.floor(Math.random() * (128 - 64 + 1) + 64);
                    for (let i = 0; i < count; i++) {
                        payments.push({
                            recipientId: testWallets[i % testWallets.length].address,
                            amount: "1"
                        });
                    }
                } else {
                    payments = config.multiPayments;
                }

                for (const payment of payments) {
                    transaction.addPayment(payment.recipientId, payment.amount);
                }

            } else if (type === Enums.TransactionType.DelegateResignation && Managers.configManager.getMilestone().aip11) {

            } else if (type === Enums.TransactionType.HtlcLock && Managers.configManager.getMilestone().aip11) {
                transaction.recipientId(recipientId)
                transaction.amount(config.amount);

                if (config.htlc.lock.expiration.type === Enums.HtlcLockExpirationType.EpochTimestamp) {
                    const networktime = await retrieveNetworktime();
                    if (config.htlc.lock.expiration.value < networktime) {
                        config.htlc.lock.expiration.value += networktime;
                    }
                }

                transaction.htlcLockAsset(config.htlc.lock);
            } else if (type === Enums.TransactionType.HtlcClaim && Managers.configManager.getMilestone().aip11) {

                const claim = config.htlc.claim;
                const lockTransactionId = claim.lockTransactionId || ((await retrieveTransaction(senderWallet.publicKey, 8))[0].id)

                transaction.htlcClaimAsset({ ...claim, lockTransactionId});

            } else if (type === Enums.TransactionType.HtlcRefund && Managers.configManager.getMilestone().aip11) {
                const refund = config.htlc.refund;
                const lockTransactionId = refund.lockTransactionId || ((await retrieveTransaction(senderWallet.publicKey, 8))[0].id)

                transaction.htlcRefundAsset({ lockTransactionId });
            } else if (type === 11 && Managers.configManager.getMilestone().aip11) {
                const mapAction = {
                    register: { action: MagistrateCrypto.Enums.EntityAction.Register },
                    update: { action: MagistrateCrypto.Enums.EntityAction.Update },
                    resign: { action: MagistrateCrypto.Enums.EntityAction.Resign },
                };
                const entityAsset = {
                    type: parseInt(splitInput[2]),
                    subType: parseInt(splitInput[3]),
                    ...mapAction[splitInput[4]],
                    data: {}
                };
                if (entityAsset.action === MagistrateCrypto.Enums.EntityAction.Register) {
                    entityAsset.data.name = splitInput[5];
                    entityAsset.data.ipfsData = splitInput[6];
                } else if (entityAsset.action === MagistrateCrypto.Enums.EntityAction.Update) {
                    entityAsset.registrationId = splitInput[5];
                    entityAsset.data.ipfsData = splitInput[6];
                } else if (entityAsset.action === MagistrateCrypto.Enums.EntityAction.Resign) {
                    entityAsset.registrationId = splitInput[5];
                }
                transaction.asset(entityAsset);
            } else {
                throw new Error("Version 2 not supported.");
            }

            let vendorField = config.vendorField.value;
            if (!vendorField && config.vendorField.random && (type === 0 || type === 6 || type === 8)) {
                vendorField = Math.random().toString();
            }

            if (vendorField) {
                transaction.vendorField(vendorField);
            }

            if (config.multiSignature.enabled && type !== 4) {
                const multiSigAddress = multiSignatureAddress();
                transaction.senderPublicKey(multiSigAddress.publicKey);
                console.log(`MultiSignature: ${JSON.stringify(multiSigAddress, undefined, 4)}`);
            }

            if (config.multiSignature.enabled || type === 4) {
                if (type === 4) {
                    const multiSignatureAddress = Identities.Address.fromMultiSignatureAsset(transaction.data.asset.multiSignature);
                    console.log(`Created MultiSignature address: ${multiSignatureAddress}`);
                    transaction.senderPublicKey(senderWallet.publicKey);

                    const participants = config.multiSignature.asset.participants;
                    for (let i = 0; i < participants.length; i++) {
                        transaction.multiSign(participants[i], i);
                    }
                } else {
                    for (const {index, passphrase} of config.multiSignature.passphrases) {
                        transaction.multiSign(passphrase, index);
                    }
                }
            }

            if (!config.multiSignature.enabled || type === 4) {
                sign(transaction, senderSecret);

                if (config.secondPassphrase) {
                    secondSign(transaction, config.secondPassphrase);
                } else if (senderWallet.secondPublicKey) {
                    secondSign(transaction, "second passphrase");
                }
            }

            const instance = transaction.build();
            const payload = instance.toJson();

            if (config.verbose) {
                console.log(`Transaction: ${JSON.stringify(payload, undefined, 4)}`);
            }

            assert(instance.verify() || config.multiSignature.enabled);
            transactions.push(payload);
        }

        await postTransaction(transactions)

    } catch (ex) {
        console.log(ex.message);
    } finally {
        prompt(`Ѧ `, main);
    }
}

const sign = (builder, passphrase) => {
    if (!config.ecdsa) {
        builder.sign(passphrase)
    } else {
        const buffer = Transactions.Utils.toHash(builder.data, {
            excludeSignature: true,
            excludeSecondSignature: true,
        });

        builder.data.signature = Crypto.Hash.signECDSA(buffer, Identities.Keys.fromPassphrase(passphrase));
    }
}

const secondSign = (builder, passphrase) => {
    if (!config.ecdsa) {
        builder.secondSign(passphrase);
    } else {

        const buffer = Transactions.Utils.toHash(builder.data, {
            excludeSecondSignature: true,
        });

        builder.data.secondSignature = Crypto.Hash.signECDSA(buffer, Identities.Keys.fromPassphrase(passphrase));
    }
}

const retrieveSenderWallet = async sender => {
    try {
        const response = await httpie.get(`http://${randomSeed()}:4003/api/wallets/${sender}`);
        return response.body.data;
    } catch (ex) {
        console.log(sender);
        console.log("retrieveSenderWallet: " + ex.message);
        console.log("Probably a cold wallet");
        return {};
    }
}

const retrieveTransaction = async (sender, type) => {
    try {
        const response = await httpie.get(`http://${randomSeed()}:4003/api/transactions?type=${type}&senderPublicKey=${sender}`);
        return response.body.data;
    } catch (ex) {
        console.log("retrieveTransaction: " + ex.message);
        return {};
    }

}

const retrieveNetworktime = async () => {
    try {
        const response = await httpie.get(`http://${randomSeed()}:4003/api/node/status`);
        return response.body.data.timestamp;
    } catch (ex) {
        console.log("retrieveNetworktime: " + ex.message);
        return 0;
    }

}

const multiSignatureAddress = () => {
    return {
        publicKey: Identities.PublicKey.fromMultiSignatureAsset({
            min: config.multiSignature.asset.min,
            publicKeys: config.multiSignature.asset.participants.map(passphrase => Identities.PublicKey.fromPassphrase(passphrase)),
        }),
        address: Identities.Address.fromMultiSignatureAsset({
            min: config.multiSignature.asset.min,
            publicKeys: config.multiSignature.asset.participants.map(passphrase => Identities.PublicKey.fromPassphrase(passphrase)),
        }),
    }
}

const postTransaction = async transactions => {
    try {
        if (config.coldrun) {
            return;
        }

        const response = await httpie.post(`http://${randomSeed()}:4003/api/transactions`, {
            headers: { "Content-Type": "application/json", port: 4003 },
            body: {
                transactions: transactions,
            },
            timeout: 5000,
        });

        if (response.status !== 200 || response.body.errors) {
            console.log(JSON.stringify(response.body));
      //      process.exit();
        } else {
            console.log(`Ѧ SENT ${transactions.length} transaction(s) [TYPE: ${transactions[0].type}] Ѧ`)
        }
    } catch (ex) {
        console.log(JSON.stringify(ex.message));
    }
}

const randomSeed = () => {
    if (config.peer) {
        return config.peer;
    }

    return seeds[Math.floor(Math.random()*seeds.length)];
}


prompt(`Ѧ `, main);

Transactions.TransactionRegistry.registerTransactionType(MagistrateCrypto.Transactions.EntityTransaction);

const builders = {
    0: Transactions.BuilderFactory.transfer,
    1: Transactions.BuilderFactory.secondSignature,
    2: Transactions.BuilderFactory.delegateRegistration,
    3: Transactions.BuilderFactory.vote,
    4: Transactions.BuilderFactory.multiSignature,
    5: Transactions.BuilderFactory.ipfs,
    6: Transactions.BuilderFactory.multiPayment,
    7: Transactions.BuilderFactory.delegateResignation,
    8: Transactions.BuilderFactory.htlcLock,
    9: Transactions.BuilderFactory.htlcClaim,
    10: Transactions.BuilderFactory.htlcRefund,

    // TECHNICALLY, the AIP103 types are in typeGroup 2
    // and range from type 0 - 5. But to keep things simple we simply
    // pretend they follow up on HTLC.

    11: () => new MagistrateCrypto.Builders.EntityBuilder(),
}

const seeds = [
    "167.114.29.33",
    "167.114.29.34",
    "167.114.29.35",
    "167.114.29.36",
    "167.114.29.37",
    "167.114.29.38",
    "167.114.29.39",
    "167.114.29.40",
    "167.114.29.41",
    "167.114.29.42",
    "167.114.29.43",
    "167.114.29.44",
    "167.114.29.45",
    "167.114.29.46",
    "167.114.29.47",
    "167.114.29.48",
]

const testWallets =
[
    {
        "passphrase": "2.6-wallet1",
        "address": "DHKxXag9PjfjHBbPg3HQS5WCaQZdgDf6yi",
        "publicKey": "02ca35b12058437774b47b0fde00a80c680855403330ce41bdefef6e504661f7ed"
    },
    {
        "passphrase": "2.6-wallet2",
        "address": "DBzGiUk8UVjB2dKCfGRixknB7Ki3Zhqthp",
        "publicKey": "022668b4d0135cf1d221f1bdf8b6a3a3027bb6adedce32a737553291481e64e490"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet3",
*        "address": "DFa7vn1LvWAyTuVDrQUr5NKaM73cfjx2Cp",
*        "publicKey": "03774243fda69f3d78d78901f5c349844725c382218668ce57b9ef321e3156e09d"
*    },
*    {
*        "passphrase": "2.6-wallet4",
*        "address": "DSGsxX84gif4ipAxZjjCE2k2YpHmsNTJeY",
*        "publicKey": "0391266d70afe3e7a82558124349073a3776d2ef7ffd1389af1b82a5da0f2f80e4"
*    },
*/    {
        "passphrase": "2.6-wallet5",
        "address": "DQhzMRvVoCYCiZH2iSyuqCTcayz7z4XTKx",
        "publicKey": "03a23637f079abde0deb5860daa4d26717855af14c6dded8bc401bda4465f4b747"
    },
    {
        "passphrase": "2.6-wallet6",
        "address": "DMSD6fFT1Xcxh4ErYExr5MtGnEuDcYu22m",
        "publicKey": "0223b47710716023b45d37a2e45d6cafcabcb0541f4c9d57f946f1fa5630c2d026"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet7",
*        "address": "D7HCZG8hJuJqu9rANRdyNr6N1vpH2vbyx8",
*        "publicKey": "02c9fe0a7d00de22ceecc1d66d241fcfee8ede041e5b19c2ab84ced884d3f0d575"
*    },
*    {
*        "passphrase": "2.6-wallet8",
*        "address": "DQy6ny2bkvWiDLboQMZ1cxnmoNC5JM228w",
*        "publicKey": "0383970e574c2321e2c46eec3b5ccac23f78c8b98f1949713b17a63b9c845aa9a6"
*    },
*    {
*        "passphrase": "2.6-wallet9",
*        "address": "D7EUgmA78qUaSfsNedfgKs2ALq28FhL3zo",
*        "publicKey": "0252efe7ef7d891abd169ab40c40cd182fff63f76198e3c17003f6c32c43e75ff0"
*    },
*/    {
        "passphrase": "2.6-wallet10",
        "address": "DEHyKHdtzHqTghfpwaBcvTzLpgPP5AAUgE",
        "publicKey": "02e7e9b33d19e5aa7ad092e8cdb5c973b44e2c761840c64a1abbe5571bb317d464"
    },
    {
        "passphrase": "2.6-wallet11",
        "address": "DBgA92a616rwVi9GsgYUwBq9Y7dgvZiC41",
        "publicKey": "028b84f92ec7ec7a019973c9183403304ae9564787b66c242fa899c299617812af"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet12",
*        "address": "DPXaJv1GcVpZPvxw5T4fXebqTVhFpfqyrC",
*        "publicKey": "03b47ad2b70ea6a3ee90886494bf72bddcf0c5f856d71d50de99019321661537a5" 
*      },
*/    {
        "passphrase": "2.6-wallet13",
        "address": "D6JpPhN7BehrhNy7AbSQ2u9mkSZb1k7Ens",
        "publicKey": "03c2b313282db91aad627c4a52d47bec99eb7c6e637399bb213c8aff652f9b7494"
    },
    {
        "passphrase": "2.6-wallet14",
        "address": "D9sdJ42YtJpXeL7Fa1cTLiciW7FpGYqms4",
        "publicKey": "03215cb65a51897465c7ee5da007a4506b8451b004749dfe28d4debaa17f6423ea"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet15",
*        "address": "DJq86RdmTMKC257szcXRXKpbuoYPaL8KgL",
*        "publicKey": "032fbed996f4142c8466af17542dbdfb52e3e8d114c4ba59131ff4ab519fab2048"
*    },
*    {
*        "passphrase": "2.6-wallet16",
*        "address": "DMsQKioFXniGH3vHDNfkQLRRqsQsAS46Cy",
*        "publicKey": "037e15b900fa60ef6a63e5c7b412b51631834bd6b429fcccaaf355f30c1a1955ae"
*    },
*    {
*        "passphrase": "2.6-wallet17",
*        "address": "DHwPoAP8cMP9ZeKrhh5c99WzaoJqFKW2qi",
*        "publicKey": "03fa155b267a239068d34e845ce1bcc0a0187d08b886cbde6152078fcb0a827f92"
*    },
*/    {
        "passphrase": "2.6-wallet18",
        "address": "DAwN6Pp4ErGf69EypErrbtuWFfEMtuSzmE",
        "publicKey": "02d9bc80a3e40742ba116ebfaeaa7d792ccdfefa3dd24762b3d02a0e3e4e67af6d"
    },
    {
        "passphrase": "2.6-wallet19",
        "address": "DQ6sE3jE9rTFC13e2ndooRdy5YCYinLbPm",
        "publicKey": "033b93fed9f0f6b84ccb23389d24b564b13d3ad2bb0b9ab7938d4700fb3a80ce03"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet20",
*        "address": "DFuo2NGezzHGwHjzG6c21JuJ9WpntLGFER",
*        "publicKey": "02367c5f781daf087400f7e2e6e732c94de8fa28058bd45f7f4ff30838cd64b195"
*    },
*/    {
        "passphrase": "2.6-wallet21",
        "address": "D6qzeJEGG7rEBem5bNCCZqHtPCBtzsUZpP",
        "publicKey": "02ecd3dcdd17f36ba7ba0b4ff836b03fff2300f7e324431de39503bf1ef804989a"
    },
    {
        "passphrase": "2.6-wallet22",
        "address": "DNVhLKTPh4LnqhcnkogNS8iSxmsnFG17tC",
        "publicKey": "02db4da057fe2c0ba1b934fbd4c4415ef54c5dad859cc90fe95e9a875fde8d319f"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet23",
*        "address": "D8EPxx42Dr4bd8xXRbMHi8LHefFLaT2VaM",
*        "publicKey": "02a4fb5d04ec1cd75ba1ed0af7bc26caf455d5c4f05b59fbff93f324279e31c096"
*    },
*    {
*        "passphrase": "2.6-wallet24",
*        "address": "DBK4VPsUQHUYkGc47FqF69PEyPjjqvnGzu",
*        "publicKey": "02cea3397a832c8d72ef7dae0f6e0e835fdb2b8a44c6b5d142a1401fa8ad230459"
*    },
*/    {
        "passphrase": "2.6-wallet25",
        "address": "D7XtDDKh2VrRtz5rtbBicfgSEoEQzEZiNx",
        "publicKey": "03be3feac3dd670643b5a6ac013f8a3ca37cfc7c8efe3d93dd532c97b6d203300a"
    },
    {
        "passphrase": "2.6-wallet26",
        "address": "D9gQjhu2tDUstXfrbK85zHi23VtAk72qsS",
        "publicKey": "020c2f9c124dacb9bfd6b9373e35c1c07aab8c6ecd50fa3b2946c79a79a1838687"
    },
    {
        "passphrase": "2.6-wallet27",
        "address": "DKhfkyY4RZyxR7CFjQAeNtGKXAaVEBa9HK",
        "publicKey": "025921ff2ca02733ee9760ab7ad7b1db628adaee36317db5a0fba9da876c001298"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet28",
*        "address": "DMCBerfV13HBuJEwJTZRVTWzrYDxgb3QSy",
*        "publicKey": "03b6317a46b5b7067eb9ec415f1c39e6f78ad7cbed1830a4a5a97b67119a149444"
*    },
*    {
*        "passphrase": "2.6-wallet29",
*        "address": "DLCoxbHdf9LMhEavEnj8mGv4AwVk8eEiKd",
*        "publicKey": "02d065e7eeed6319289ea31c1fbff98025a8c302b92754ea1d3e71cf7bd419928e"
*    },
*/    {
        "passphrase": "2.6-wallet30",
        "address": "D5taz6B4xDk1LD3jV4fYrUhaKC8DnTtziW",
        "publicKey": "0352ff2cbd609fdcfc032c18c6a667009044fdb3ed279ceca2092638ac8bd6d06c"
    },
    {
        "passphrase": "2.6-wallet31",
        "address": "DDb3EXY3refv2f5ymMME3hp2DXFqMPzGah",
        "publicKey": "021d83e48f132a94dba93b216ae7a2b35965bf02818246393164bfee6c36f3f56b"
    },
    {
        "passphrase": "2.6-wallet32",
        "address": "D5HydybffvfuwdbBKQ1dnhiXzNnWq6CgQz",
        "publicKey": "03b3a212f8eff66c6bfda38090e75a9a82015438048a758b3a7c6d7dc050551455"
    },
    {
        "passphrase": "2.6-wallet33",
        "address": "D9DMKvx8fDyWyAP1EUGs5McBwwv3y5E1Yn",
        "publicKey": "02ce5dda5b417698c998af763176a8255b507b48929826074e56e60d30a16a622d"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet34",
*        "address": "DHXqndno9dBvGabhc7NdZWuoj6nRUdSaP7",
*        "publicKey": "028840ad6afd8cfc2cd7d176532d0daa48de4caba5c2936bab5fb5147956c006bb"
*    },
*/    {
        "passphrase": "2.6-wallet35",
        "address": "DJAmJiuLQGnzXWmH7KvosVLks7hhfxQ8np",
        "publicKey": "021085fef11deb2a3c3a532f340422f22944dbfa751d22ea62fd8d3801f352c6fd"
    },
    {
        "passphrase": "2.6-wallet36",
        "address": "D752ZwkQZKm5gYYMUZV2tKFFZZaD35MtRa",
        "publicKey": "03395ce74f7d696edee6e34bc68b7c41348f558ee99766389adcf93e6291d8c37b"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet37",
*        "address": "D6Xe5kVsK7axaPZ1tP2fVWaLFubyCajkVq",
*        "publicKey": "022ff3fe2cedfff2713b5f29b714db6e772b775fa88cfb24baec9eedb1ec25e91e"
*    },
*/    {
        "passphrase": "2.6-wallet38",
        "address": "D9yDJNK4xHP9Gx27s187Z5XHcNF5YFA94h",
        "publicKey": "02ff1f60dd2800e1941ae51ff6fb5244bf295bd65eec07c0b82c1ac887b14dcc64"
    },
    {
        "passphrase": "2.6-wallet39",
        "address": "DJuZC2smL8j86bUNrZiNceAubad3zs3drS",
        "publicKey": "0259d03d5c09ac98fc3fe9731ed007cd36e3fd88dfaf1f8cbbcb5cade349ba51ee"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet40",
*        "address": "DRUVFo5MjNrMHHQCwpVPH6AwLL2AULpgbH",
*        "publicKey": "03473f40da27e112c7d50810553da963460f3a61d1f37b565b2d269307a542786a"
*    },
*    {
*        "passphrase": "2.6-wallet41",
*        "address": "DNM5wLmqVUz6UgY14mt6BsMndy8JGcFwct",
*        "publicKey": "0211e7783cae370f90d7751482af0667730765f9756b7d4871157ed41a38bd94d9"
*    },
*    {
*        "passphrase": "2.6-wallet42",
*        "address": "DHMd77xyB8f6DnSCgxaRWfuM86cwyH76EH",
*        "publicKey": "0394f0a5d858b6c978853c03840eabf950e7db6ca9ee4a2b0e05c124c0c562a1ea"
*    },
*/    {
        "passphrase": "2.6-wallet43",
        "address": "DFmg9q2KqGyretLazvRjWdynJAZbPkZPG2",
        "publicKey": "0248b2103dc49a8cb78931037fd9e7bafb0cff52c4c106bbc2732b93a9cadbd03a"
    },
    {
        "passphrase": "2.6-wallet44",
        "address": "DMnY8QWLAmsb4wNEjRVvtQsNWF4SbXntxM",
        "publicKey": "03b88068bce125a3cbe86607d64c138c3c3ef79bf4c1589e7604a3a9bf6f3d5370"
    },
    {
        "passphrase": "2.6-wallet45",
        "address": "DBMn94FxVB36nXgzbmtmfu6jVEGwwHNyNA",
        "publicKey": "03630de470d97f0c99b60cfc0990b756fb26a7201005ba83b98b1829a0b9627d7a"
    },
    {
        "passphrase": "2.6-wallet46",
        "address": "DUD3r46LtArk4msu6jFrwn1hjxbZoXzX9t",
        "publicKey": "035950433667d3868c5778de98e41a47b0358afc8f853c87e1ce928315522325cc"
    },
    {
        "passphrase": "2.6-wallet47",
        "address": "DFUNVTBd5zFexBaHkymr4UJqsHeXhPLKUF",
        "publicKey": "030a5e6f4098883281d9c0d7a7c8eaf0402ed3ab5ea763eef11a197f484aa2b160"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet48",
*        "address": "DFtCxvMSsF9qfw2mH1aNHxusXGJ2QzCahP",
*        "publicKey": "03b84ccd6c9a28e47c5095e1b544d4fb488f41f2276fda6743a0d0b4947363d185"
*    },
*/    {
        "passphrase": "2.6-wallet49",
        "address": "D8LiYnmH4DLDyxCLTV7RrqxtCA21pfGkb9",
        "publicKey": "0387873485f1af537fed3efc2341907aa8b0e9ae1c331bdff9f679277a0a23b7cb"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet50",
*        "address": "DASUgX1U7yvp8WDQ57QoTEUim6bqTYzxGw",
*        "publicKey": "03017e8f1a470873ed69256daf64208dcba855576bd4d7dbd8e84ae3d1189b0a2c"
*    },
*/    {
        "passphrase": "2.6-wallet51",
        "address": "D5iNaf5ZckhdZivPfy6vFvBLeBDJtvDoGo",
        "publicKey": "0236effbd21efb0aa2b4b06b97b29eaba1532339b741f63be32551297b40ebe893"
    },
    {
        "passphrase": "2.6-wallet52",
        "address": "DPrdeuFDcfMujvYK6n18RBAWgh7hYeiDeZ",
        "publicKey": "02fdc1278fdf07d5d9cce34f3ea1934e6ff7f38777f49bb600c994515c188e3ecb"
    },
    {
        "passphrase": "2.6-wallet53",
        "address": "D9oaC7bd2YaJYHDdGkUdyAnfpkBrFFKZHy",
        "publicKey": "034f66df17f860b8b8b0e8172cc284a92b61d451a3388487b284990ccf7e3e933b"
    },
    {
        "passphrase": "2.6-wallet54",
        "address": "DUTUfseKR6qJRjqCuxeH3oRxMr6EFLUxRW",
        "publicKey": "029b315516f740c9e81fb815c77581870587c1ee251e363c8ef1603d6f6d8fcad0"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet55",
*        "address": "DTYv1v3YdUNy81kzD1VhRx6e8jkDYnvCoh",
*        "publicKey": "034e15c888dec79d828cdd4e283eba6d6eea5a74133467cd21fdfaf1183e7b2fb4"
*    },
*/    {
        "passphrase": "2.6-wallet56",
        "address": "DE1BK8iL17PiBwo9TUCfkkm1vnUkobBwj8",
        "publicKey": "028d0f82396ee16371f423042774bb66e07f1306b73d6e25e6c712342b0c54f91c"
    },
    {
        "passphrase": "2.6-wallet57",
        "address": "D7Ba6DnbpPJgqVnQNdN7baRsZs1DKvptMM",
        "publicKey": "02e4e3d997b9c160e11bc4bf79f011cc7adee0a8d23a244c37c231dedf29f659c6"
    },
    {
        "passphrase": "2.6-wallet58",
        "address": "DUBcre2e5KMykYr6xK56T5BrwkKMZkUF8r",
        "publicKey": "03b1a962a3a06237776efe6299b9ef95fb81cf5fd2a98a0ec951533df7839f36cc"
    },
    {
        "passphrase": "2.6-wallet59",
        "address": "DPeqoTgBbRhyuEJtMnhqhSAeK32ymMNvjd",
        "publicKey": "028c430df44c120ed342e37da5ea8992eac6755c43fe6a6a870b02ae81a943ba75"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet60",
*        "address": "DGmToX3GrCEUC8EJdZrXWTYFNWqQz1VVhX",
*        "publicKey": "02dbb906c749b8b053baf12af03295672ab544ba00c24cb01eae1917c581c55a6b"
*    },
*    {
*        "passphrase": "2.6-wallet61",
*        "address": "DArHKTMXf3F5zXS1i3GSwni9aA8TX1yQvh",
*        "publicKey": "030fb55cb76ec08cde763c69119c686bb91d60359d9f6dd69ecb5013dac7669a81"
*    },
*    {
*        "passphrase": "2.6-wallet62",
*        "address": "DTgcCvAYR2XdzUHv4WuEB6aShYEbh2MYp6",
*        "publicKey": "02b19c72247dbf357a811b516526daf8a861ecf0577105c90ae53e4edb99ef6b89"
*    },
*/    {
        "passphrase": "2.6-wallet63",
        "address": "DFLY9huetM6GMrt9EGp6sXDEiC7r3oSYHg",
        "publicKey": "0318fcac6cd16617340ce11fb7f33c2fb9861dfff8dc5304a7a55b6672154b7cf1"
    },
    {
        "passphrase": "2.6-wallet64",
        "address": "DEszKKqdRipXiF7BDKS2Q4iJwwfzLdwADK",
        "publicKey": "03a819a41b0f00e80f46ee369633a0fab779841ff44b530ba530169bb8c5b2e242"
    },
    {
        "passphrase": "2.6-wallet65",
        "address": "DF45FRKUYcyUGeZyyTF3sCYJ8VFNXymzhJ",
        "publicKey": "0246812d42b455b806f8cda6ff3808471a9a362c709d89867b296fb67f29085188"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet66",
*        "address": "DJb6jvhSvw2RmxCBEQSAzG6tjUs5rK3a5m",
*        "publicKey": "031731b0dd73531152ac42e22e65277c67f25feea9939c163e10d7cb78b15d007a"
*     },
*/    {
        "passphrase": "2.6-wallet67",
        "address": "DCqqT4x4on1dsbgUKRWkuZsdZaoohYK6NV",
        "publicKey": "020611b40c71f84dfe6e41397d02c93512881bd577b6ec8379cdaefab1ab85e0f5"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet68",
*        "address": "D9SAVjqkxwWQmb82iqAedJPccFjDUnMSi9",
*        "publicKey": "03db91f46dcd94311ab51efc9ca352e2628c27ffce63d1a609a14b8473c0db5b5d"
*    },
*    {
*        "passphrase": "2.6-wallet69",
*        "address": "DBvXesEgzrAsm9YrzRb2jithR2hg7SZpuq",
*        "publicKey": "02a32a35920db1fbf3dfd5582d983d43fa4edf3fa1e51fa3fd084005b7a28f239b"
*    },
*/    {
        "passphrase": "2.6-wallet70",
        "address": "DF5ZYcQsmgDvH6cVQR87xvXapyTUFB1a5R",
        "publicKey": "03ed92fb37629bf1c7f573e175e27c1a30e31b7e1814d0635845ce4b0d375b655e"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet71",
*        "address": "DQEfNNsJ6PQTA9abwWdiunPuebLZAhxbpZ",
*        "publicKey": "02d076488f8d0eb85cdbebe0d24e0a66ac20aed104ac463647ffb44673743358c6"
*    },
*/    {
        "passphrase": "2.6-wallet72",
        "address": "DP6k5YTtaeNJUHZ72H6QtugFaHVB5vEBQe",
        "publicKey": "03abaa80de87f0ce5d41c47374cc09e219f7d4138331c7d60db8ea925967cada5a"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet73",
*        "address": "DJBTrPo6sDMGr2kcswTwDWtQyYV5adqnAp",
*        "publicKey": "020d615fe41e47e04d54fd4a6f78899f505a28fd2e02623cddbdcb6b91cafcd3fe"
*    },
*    {
*        "passphrase": "2.6-wallet74",
*        "address": "DMHtTBMyG5qGYgcZNRkb36XaCT3TUSKmYE",
*        "publicKey": "02e3f3c56464286deb9e5fd473e8c0db98f772fd8c989d5748ad53614369ba24e2"
*    },
*    {
*        "passphrase": "2.6-wallet75",
*        "address": "DTbCpyVgTeJw4idpqbY5jwrEi7SxSid9GU",
*        "publicKey": "02afaac335243b963688bdd68b1e529b16bc0af06b0462d84385b52fff8bf02568"
*    },
*/    {
        "passphrase": "2.6-wallet76",
        "address": "D75g1ztcaHi46eUFRnakRryqG7GV9xsgGC",
        "publicKey": "036c613ec27de52db43f3278cc816b5decabdb24dd0dd1b5b297572474fcbd7079"
    },
    {
        "passphrase": "2.6-wallet77",
        "address": "DSkMiPrEx3YF6ijDjxhwCnbAbriC8sWKEW",
        "publicKey": "03bff2fb4d7852040cb3510d0daf01464e84788027f6f21eea39e4cc782340dbba"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet78",
*        "address": "D7BHGU3UedoxpZko4nBLcz5oRtSmUmRfy6",
*        "publicKey": "02d34e543f52ed85c7993eca442fa66f18720cc676305f89da3533d898385473b6"
*    },
*/    {
        "passphrase": "2.6-wallet79",
        "address": "DQZUzueTvUJb5tnhBCziPYaMnzaoui4F57",
        "publicKey": "021beb69e7303005d4594912b90a7995bd07d24ec382e90584c7d4c8c93e97089a"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet80",
*        "address": "DGCCpnJ86YvxJAkHRPhC5jTBNGsy5PEDRh",
*        "publicKey": "02afe630a4feaacdb12162a0107ac395189548246a0c148ebfdb79641a25778a16"
*    },
*/    {
        "passphrase": "2.6-wallet81",
        "address": "DHSW3vi66L63xnzRt9PadwSVrb9bCKhgvJ",
        "publicKey": "025da4ebd800f85e96e31590e162bf2d9f78ae9174655d6bdec201a99bd6580ce2"
    },
    {
        "passphrase": "2.6-wallet82",
        "address": "D6eAmMh6FFynorCSjHS1Qx75rXiN89soa7",
        "publicKey": "02fa2d048e3beeeb6eb1a307f83e3192f8a244d13ef6dc144caa9677e560b7da67"
    },
    {
        "passphrase": "2.6-wallet83",
        "address": "DGPoaSg15fb6As8bPKBAQrK3nCDpgfYow8",
        "publicKey": "029fa9f69b302ff49a252e07b4722de81b8105746543085832e9dca293bebe7aff"
    },
    {
        "passphrase": "2.6-wallet84",
        "address": "DKPmC4G1ZEwxb5hZro2sJwRWJ1pQixcK6N",
        "publicKey": "0317d9ca2a86d583facbc3ab7a0705eafc89199055d46055fb01950c53bc4dfa21"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet85",
*        "address": "DFpBcXzcJdFaN9rfVD8Nc5yWFvJ3DnePwa",
*        "publicKey": "0270268655206b2e883ee5e022f5f7dbf8f437f0962c313fa637bc33d32245f5ff"
*    },
*    {
*        "passphrase": "2.6-wallet86",
*        "address": "DKxQ9FDTBDQaLLV24sWc625w2Kycw2RoqR",
*        "publicKey": "03bd69f4795c9e9a816ea04276b343c58c223289b151b224d0681f72c6605889ef"
*    },
*    {
*        "passphrase": "2.6-wallet87",
*        "address": "DNZr7NxGm97r8hV6Jg4rv3S5MgJrEVUWNQ",
*        "publicKey": "03cf4170af803d6f15987523b3fedd1c0a62a20e9ff15d8b47fe00049adf3c0f3a"
*    },
*/    {
        "passphrase": "2.6-wallet88",
        "address": "DBBbtnKKDAW84bDjywEmQFLgwf36DxJHZJ",
        "publicKey": "03c53de42449df160356b7382af168903153ac95491994ab6c278840cd00872c68"
    },
    {
        "passphrase": "2.6-wallet89",
        "address": "DA7GfDKG5zYFeiZ1C4FPJBeTajpYNvXxcC",
        "publicKey": "0256ee467ae3129537189eb02f4d81d80e428aa5b2a53668f5ce2c6d3a9ca6ab2c"
    },
    {
        "passphrase": "2.6-wallet90",
        "address": "DPAsWQyuxYkiMRzhngKBPTpWb6WWqxdd1T",
        "publicKey": "034496bb34624c8381391273c228681d982668086fcb994e8817fa1907db4ba2ff"
    },
    {
        "passphrase": "2.6-wallet91",
        "address": "DTv6qvhUK1jks58gAA5YFzShHf3YX9sJVo",
        "publicKey": "02ec03ed1353c578a79dec8b20f56f253cc929c5b5a9550598592ab6fbccee1a7e"
    },
    {
        "passphrase": "2.6-wallet92",
        "address": "DDwTm5FbgvWugYekvjE1dzantAVKxtGbNo",
        "publicKey": "025d655104eb6ed75d5fd1b400ba27dad48147a487dd532db12f11bfe5f2be38ca"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet93",
*        "address": "DTno4QZdEyAokZHxQZcYrErqMLVE19PgCb",
*        "publicKey": "0271576e800f53585eb322b3229ca2f7d9177c564dd966351a6434fb56fc4a6158"
*    },
*    {
*        "passphrase": "2.6-wallet94",
*        "address": "D5xRcwzEGSN83nyuGN74Sw8f353vDmm2tt",
*        "publicKey": "03782a5c77892798195b5c1b54133c7139debc63551523ee37e5b4d0be6a7e7fe4"
*    },
*    {
*        "passphrase": "2.6-wallet95",
*        "address": "DC1hKDKyFbtMhiTc79mmPS99SJnQLsvvH3",
*        "publicKey": "03b73401ada208b1c79522bf9698c74b6e40cb7d3f645566e5fd33053a955aa3b9"
*    },
*/    {
        "passphrase": "2.6-wallet96",
        "address": "DM1pVjbHA3Q4dezcwGBjmT54cLYqpx1NtZ",
        "publicKey": "02a8ac3ca69a778e3da70ac63d408f202317de14bb83b8f75d218b32cea7c345e4"
    },
    {
        "passphrase": "2.6-wallet97",
        "address": "DFEMw6jihEKRJ9CT3k8Rj73PLKDGDyQLU1",
        "publicKey": "020faf38e8b2b1ec22e8d5de02b9b7f8114ec5c555a8efd96631eb864c1485b778"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet98",
*        "address": "D5nTPSQFkt9W6mNzdy5ks5PiHkhDqswxDY",
*        "publicKey": "031e3503ff900dc9d5cba44c25784cc4635d288a0a28df86c30b46ea4ee843ab13"
*    },
*/    {
        "passphrase": "2.6-wallet99",
        "address": "DMca1DGMxj8w59dWYmji1YC1xLP7AmL6rA",
        "publicKey": "03959b58145d38e33c9c9eafd0edbde953bdb5afdd45ad4f8bbff7f42c03f1fa89"
    },
/*    {                                                                                   //unknown 2nd passphrase
*        "passphrase": "2.6-wallet100",
*        "address": "DM6emC4WnxyP2RzrNW5VMS2n3sNfz6Xpci",
*        "publicKey": "02e4d8687dc6cc60ec07e87e28d372dc15819a5ecb0a2180f1201bbbb55e1a0881"
*    }
*/]
