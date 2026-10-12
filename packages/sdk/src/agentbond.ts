/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/agentbond.json`.
 */
export type Agentbond = {
  "address": "FPymWjwqaqmXQ3ozKNRdBP9FNyWqQcE5TepHvUBgMB1U",
  "metadata": {
    "name": "agentbond",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "approveWork",
      "discriminator": [
        181,
        118,
        45,
        143,
        204,
        88,
        237,
        109
      ],
      "accounts": [
        {
          "name": "verifier",
          "signer": true,
          "relations": [
            "job"
          ]
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "verificationHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "cancelJob",
      "discriminator": [
        126,
        241,
        155,
        241,
        50,
        236,
        83,
        118
      ],
      "accounts": [
        {
          "name": "creator",
          "signer": true,
          "relations": [
            "job"
          ]
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "claimJob",
      "discriminator": [
        9,
        160,
        5,
        231,
        116,
        123,
        198,
        14
      ],
      "accounts": [
        {
          "name": "worker",
          "signer": true
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createJob",
      "discriminator": [
        178,
        130,
        217,
        110,
        100,
        27,
        82,
        119
      ],
      "accounts": [
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "job"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "verifier",
          "type": "pubkey"
        },
        {
          "name": "specHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "acceptanceHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "claimDeadline",
          "type": "i64"
        },
        {
          "name": "submitDeadline",
          "type": "i64"
        },
        {
          "name": "verifyDeadline",
          "type": "i64"
        }
      ]
    },
    {
      "name": "fundJob",
      "discriminator": [
        244,
        198,
        4,
        15,
        41,
        178,
        169,
        187
      ],
      "accounts": [
        {
          "name": "creator",
          "signer": true,
          "relations": [
            "job"
          ]
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "job"
              }
            ]
          },
          "relations": [
            "job"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "job"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          "relations": [
            "job"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "refundJob",
      "discriminator": [
        194,
        186,
        15,
        90,
        246,
        119,
        89,
        240
      ],
      "accounts": [
        {
          "name": "creator",
          "signer": true,
          "relations": [
            "job"
          ]
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "job"
              }
            ]
          },
          "relations": [
            "job"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "job"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          "relations": [
            "job"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "rejectWork",
      "discriminator": [
        129,
        238,
        59,
        133,
        63,
        148,
        130,
        54
      ],
      "accounts": [
        {
          "name": "verifier",
          "signer": true,
          "relations": [
            "job"
          ]
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "verificationHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "settleJob",
      "discriminator": [
        246,
        155,
        221,
        34,
        168,
        70,
        173,
        72
      ],
      "accounts": [
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "job"
              }
            ]
          },
          "relations": [
            "job"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "job"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          "relations": [
            "job"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "submitWork",
      "discriminator": [
        158,
        80,
        101,
        51,
        114,
        130,
        101,
        253
      ],
      "accounts": [
        {
          "name": "worker",
          "signer": true,
          "relations": [
            "job"
          ]
        },
        {
          "name": "job",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  106,
                  111,
                  98
                ]
              },
              {
                "kind": "account",
                "path": "job.creator",
                "account": "job"
              },
              {
                "kind": "account",
                "path": "job.id",
                "account": "job"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "artifactHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "job",
      "discriminator": [
        75,
        124,
        80,
        203,
        161,
        180,
        202,
        80
      ]
    }
  ],
  "events": [
    {
      "name": "jobChanged",
      "discriminator": [
        52,
        130,
        194,
        207,
        35,
        50,
        167,
        114
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "freezeAuthorityUnsupported",
      "msg": "Escrow mint must have no freeze authority"
    },
    {
      "code": 6001,
      "name": "invalidAmount",
      "msg": "Amount must be positive"
    },
    {
      "code": 6002,
      "name": "invalidDeadlines",
      "msg": "Deadlines must be future and strictly ordered"
    },
    {
      "code": 6003,
      "name": "invalidVerifier",
      "msg": "Verifier must be distinct and nonzero"
    },
    {
      "code": 6004,
      "name": "invalidHash",
      "msg": "Hash must be nonzero"
    },
    {
      "code": 6005,
      "name": "invalidState",
      "msg": "Invalid lifecycle transition"
    },
    {
      "code": 6006,
      "name": "deadlinePassed",
      "msg": "Action deadline passed"
    },
    {
      "code": 6007,
      "name": "roleConflict",
      "msg": "Worker must differ from creator and verifier"
    },
    {
      "code": 6008,
      "name": "wrongDestination",
      "msg": "Destination must belong to assigned worker"
    },
    {
      "code": 6009,
      "name": "refundUnavailable",
      "msg": "Only rejected or expired unapproved jobs may refund"
    }
  ],
  "types": [
    {
      "name": "job",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "worker",
            "type": "pubkey"
          },
          {
            "name": "verifier",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "tokenProgram",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "acceptanceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "artifactHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "verificationHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "fundedAt",
            "type": "i64"
          },
          {
            "name": "claimedAt",
            "type": "i64"
          },
          {
            "name": "submittedAt",
            "type": "i64"
          },
          {
            "name": "verifiedAt",
            "type": "i64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          },
          {
            "name": "claimDeadline",
            "type": "i64"
          },
          {
            "name": "submitDeadline",
            "type": "i64"
          },
          {
            "name": "verifyDeadline",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "jobStatus"
              }
            }
          }
        ]
      }
    },
    {
      "name": "jobChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "job",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "jobStatus"
              }
            }
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "jobStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "created"
          },
          {
            "name": "funded"
          },
          {
            "name": "claimed"
          },
          {
            "name": "submitted"
          },
          {
            "name": "verified"
          },
          {
            "name": "rejected"
          },
          {
            "name": "settled"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "refunded"
          }
        ]
      }
    }
  ]
};
