# Runtime Events Reference

Generated from the synced GoodVibes operator event contract artifact.

## Transport endpoints

- SSE: `/api/control-plane/events`
- WebSocket: `/api/control-plane/ws`
- SSE query: `domains=comma-separated runtime domains`

Schema blocks below are emitted directly from the synced contract JSON and may contain contract-local `$ref` pointers.

## Runtime domains

### `agents`

- `runtime.agents` -> `agents`

#### `runtime.agents` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `automation`

- `runtime.automation` -> `automation`

#### `runtime.automation` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `communication`

- `runtime.communication` -> `communication`

#### `runtime.communication` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `compaction`

- `runtime.compaction` -> `compaction`

#### `runtime.compaction` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `config`

- `runtime.config` -> `config`

#### `runtime.config` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `contracts`

- `runtime.contracts` -> `contracts`

#### `runtime.contracts` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `control-plane`

- `runtime.control-plane` -> `control-plane`

#### `runtime.control-plane` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `deliveries`

- `runtime.deliveries` -> `deliveries`

#### `runtime.deliveries` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `fleet`

- `runtime.fleet` -> `fleet`

#### `runtime.fleet` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `forensics`

- `runtime.forensics` -> `forensics`

#### `runtime.forensics` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `gate`

- `control.approval_update` -> `approval-update`
- `control.owner_inbox_update` -> `owner-inbox-update`
- `runtime.gate` -> `gate`

#### `control.approval_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "approval": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "callId": {
          "type": "string"
        },
        "sessionId": {
          "type": "string"
        },
        "routeId": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "claimed",
            "approved",
            "denied",
            "cancelled",
            "expired"
          ]
        },
        "request": {
          "type": "object",
          "properties": {
            "callId": {
              "type": "string"
            },
            "tool": {
              "type": "string"
            },
            "args": {
              "type": "object",
              "additionalProperties": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "object",
                    "additionalProperties": {}
                  },
                  {
                    "type": "array",
                    "items": {}
                  }
                ]
              }
            },
            "category": {
              "type": "string",
              "enum": [
                "read",
                "write",
                "execute",
                "delegate"
              ]
            },
            "analysis": {
              "type": "object",
              "properties": {
                "classification": {
                  "type": "string"
                },
                "riskLevel": {
                  "type": "string",
                  "enum": [
                    "low",
                    "medium",
                    "high",
                    "critical"
                  ]
                },
                "summary": {
                  "type": "string"
                },
                "reasons": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "target": {
                  "type": "string"
                },
                "targetKind": {
                  "type": "string",
                  "enum": [
                    "command",
                    "path",
                    "url",
                    "task",
                    "generic"
                  ]
                },
                "surface": {
                  "type": "string",
                  "enum": [
                    "filesystem",
                    "shell",
                    "network",
                    "orchestration",
                    "platform",
                    "generic"
                  ]
                },
                "blastRadius": {
                  "type": "string",
                  "enum": [
                    "local",
                    "project",
                    "external",
                    "delegated",
                    "platform"
                  ]
                },
                "sideEffects": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "host": {
                  "type": "string"
                },
                "riskFamily": {
                  "type": "string"
                },
                "reading": {
                  "type": "object",
                  "properties": {
                    "family": {
                      "type": "string"
                    },
                    "stakes": {
                      "type": "string",
                      "enum": [
                        "low",
                        "medium",
                        "high",
                        "critical"
                      ]
                    },
                    "facts": {
                      "type": "object",
                      "properties": {
                        "mutates": {
                          "type": "boolean"
                        },
                        "outward": {
                          "type": "boolean"
                        },
                        "secrets": {
                          "type": "boolean"
                        },
                        "irreversible": {
                          "type": "boolean"
                        },
                        "beyondProject": {
                          "type": "boolean"
                        },
                        "weakensSecurity": {
                          "type": "boolean"
                        },
                        "obfuscated": {
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "mutates",
                        "outward",
                        "secrets",
                        "irreversible",
                        "beyondProject",
                        "weakensSecurity",
                        "obfuscated"
                      ],
                      "additionalProperties": false
                    },
                    "uncertain": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  },
                  "required": [
                    "family",
                    "stakes",
                    "facts",
                    "uncertain"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "classification",
                "riskLevel",
                "summary",
                "reasons"
              ],
              "additionalProperties": false
            },
            "workingDirectory": {
              "type": "string"
            },
            "attribution": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "background-agent"
                      ]
                    },
                    "agentId": {
                      "type": "string"
                    },
                    "template": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "agentId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "mcp-server"
                      ]
                    },
                    "serverName": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "serverName"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "sandbox-escalation"
                      ]
                    },
                    "sandbox": {
                      "type": "string"
                    },
                    "escalations": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  },
                  "required": [
                    "kind",
                    "sandbox",
                    "escalations"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "exec-prompt"
                      ]
                    },
                    "command": {
                      "type": "string"
                    },
                    "prompt": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "command",
                    "prompt"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "fetch-localhost"
                      ]
                    },
                    "host": {
                      "type": "string"
                    },
                    "url": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "kind",
                    "host",
                    "url"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "rememberOptions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "tier": {
                    "type": "string",
                    "enum": [
                      "session",
                      "exact",
                      "command-class",
                      "path",
                      "tool"
                    ]
                  },
                  "label": {
                    "type": "string"
                  },
                  "detail": {
                    "type": "string"
                  }
                },
                "required": [
                  "tier",
                  "label",
                  "detail"
                ],
                "additionalProperties": false
              }
            },
            "ownerOnly": {
              "type": "string",
              "enum": [
                "spend-over-limit",
                "payment-step",
                "unrecoverable-delete",
                "new-recipient",
                "untrusted-derived-send",
                "grant-access",
                "loosen-security",
                "change-contract",
                "irreversible-operator",
                "standing-ask",
                "channel-request",
                "owner-act"
              ]
            }
          },
          "required": [
            "callId",
            "tool",
            "args",
            "category",
            "analysis"
          ],
          "additionalProperties": false
        },
        "createdAt": {
          "type": "number"
        },
        "updatedAt": {
          "type": "number"
        },
        "claimedBy": {
          "type": "string"
        },
        "claimedAt": {
          "type": "number"
        },
        "resolvedAt": {
          "type": "number"
        },
        "resolvedBy": {
          "type": "string"
        },
        "decision": {
          "type": "object",
          "properties": {
            "approved": {
              "type": "boolean"
            },
            "remember": {
              "type": "boolean"
            },
            "rememberTier": {
              "type": "string",
              "enum": [
                "session",
                "exact",
                "command-class",
                "path",
                "tool"
              ]
            },
            "reason": {
              "type": "string"
            },
            "modifiedArgs": {
              "type": "object",
              "additionalProperties": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "object",
                    "additionalProperties": {}
                  },
                  {
                    "type": "array",
                    "items": {}
                  }
                ]
              }
            },
            "disposition": {
              "type": "string",
              "enum": [
                "approved",
                "denied",
                "amended",
                "cancelled",
                "expired",
                "remembered"
              ]
            },
            "argsDigest": {
              "type": "string"
            },
            "relayRequestId": {
              "type": "string"
            }
          },
          "required": [
            "approved"
          ],
          "additionalProperties": false
        },
        "expiresAt": {
          "type": "number"
        },
        "revision": {
          "type": "number"
        },
        "sequence": {
          "type": "number"
        },
        "homeNode": {
          "type": "string"
        },
        "requester": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "in-process",
                "wire",
                "record-reader"
              ]
            },
            "holds": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "releasedAt": {
                    "type": "number"
                  }
                },
                "required": [
                  "id"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        "cause": {
          "type": "string",
          "enum": [
            "requester-left",
            "requester-restarted",
            "cancelled-by-actor",
            "owner-decision-stale",
            "deadline",
            "deadline-while-down",
            "remembered-rule"
          ]
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": {}
              },
              {
                "type": "array",
                "items": {}
              }
            ]
          }
        },
        "audit": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "action": {
                "type": "string",
                "enum": [
                  "created",
                  "claimed",
                  "approved",
                  "denied",
                  "cancelled",
                  "expired",
                  "updated"
                ]
              },
              "actor": {
                "type": "string"
              },
              "actorSurface": {
                "type": "string"
              },
              "actorNode": {
                "type": "string"
              },
              "createdAt": {
                "type": "number"
              },
              "note": {
                "type": "string"
              },
              "relayRequestId": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "action",
              "actor",
              "createdAt"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "id",
        "callId",
        "status",
        "request",
        "createdAt",
        "updatedAt",
        "revision",
        "sequence",
        "homeNode",
        "requester",
        "metadata",
        "audit"
      ],
      "additionalProperties": false
    },
    "reading": {
      "type": "object",
      "properties": {
        "ref": {
          "type": "object",
          "properties": {
            "node": {
              "type": "string"
            },
            "id": {
              "type": "string"
            }
          },
          "required": [
            "node",
            "id"
          ],
          "additionalProperties": false
        },
        "revision": {
          "type": "number"
        },
        "sequence": {
          "type": "number"
        },
        "phase": {
          "type": "string",
          "enum": [
            "waiting",
            "decided",
            "ended"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "claimed",
            "approved",
            "denied",
            "cancelled",
            "expired"
          ]
        },
        "reason": {
          "type": "string",
          "enum": [
            "waiting-for-approver",
            "waiting-for-owner",
            "claimed-by-you",
            "claimed-by-other",
            "approved",
            "denied",
            "amended",
            "remembered-approved",
            "remembered-denied",
            "cancelled-requester-left",
            "cancelled-requester-restarted",
            "cancelled-by-actor",
            "cancelled-owner-decision-stale",
            "expired",
            "expired-while-down"
          ]
        },
        "waitingOn": {
          "type": "object",
          "properties": {
            "who": {
              "type": "string",
              "enum": [
                "owner",
                "approver"
              ]
            },
            "claimedBy": {
              "type": "string"
            },
            "homeNode": {
              "type": "string"
            },
            "homeReachable": {
              "type": "boolean"
            }
          },
          "required": [
            "who",
            "homeNode",
            "homeReachable"
          ],
          "additionalProperties": false
        },
        "deadline": {
          "type": "object",
          "properties": {
            "expiresAt": {
              "type": "number"
            },
            "remainingMs": {
              "type": "number"
            }
          },
          "required": [
            "expiresAt",
            "remainingMs"
          ],
          "additionalProperties": false
        },
        "allowedActions": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "claim",
              "approve",
              "deny",
              "amend",
              "cancel"
            ]
          }
        },
        "refusedActions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "action": {
                "type": "string",
                "enum": [
                  "claim",
                  "approve",
                  "deny",
                  "amend",
                  "cancel"
                ]
              },
              "code": {
                "type": "string"
              },
              "reason": {
                "type": "string"
              }
            },
            "required": [
              "action",
              "code",
              "reason"
            ],
            "additionalProperties": false
          }
        },
        "decision": {
          "type": "object",
          "properties": {
            "disposition": {
              "type": "string",
              "enum": [
                "approved",
                "denied",
                "amended",
                "cancelled",
                "expired",
                "remembered"
              ]
            },
            "by": {
              "type": "string"
            },
            "surface": {
              "type": "string"
            },
            "node": {
              "type": "string"
            },
            "at": {
              "type": "number"
            },
            "cause": {
              "type": "string",
              "enum": [
                "requester-left",
                "requester-restarted",
                "cancelled-by-actor",
                "owner-decision-stale",
                "deadline",
                "deadline-while-down",
                "remembered-rule"
              ]
            }
          },
          "required": [
            "disposition",
            "by",
            "surface",
            "node",
            "at"
          ],
          "additionalProperties": false
        },
        "receipt": {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "delivered",
                "waiting",
                "undeliverable",
                "requester-reads-record",
                "not-applicable"
              ]
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "state"
          ],
          "additionalProperties": false
        },
        "requester": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "in-process",
                "wire",
                "record-reader"
              ]
            },
            "principal": {
              "type": "string"
            },
            "surface": {
              "type": "string"
            },
            "mine": {
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "mine"
          ],
          "additionalProperties": false
        },
        "work": {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "not-reported"
              ]
            },
            "callId": {
              "type": "string"
            },
            "sessionId": {
              "type": "string"
            }
          },
          "required": [
            "state",
            "callId"
          ],
          "additionalProperties": false
        },
        "next": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "move": {
                "type": "string",
                "enum": [
                  "wait",
                  "decide",
                  "refresh",
                  "raise-again",
                  "nothing"
                ]
              },
              "text": {
                "type": "string"
              }
            },
            "required": [
              "move",
              "text"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "ref",
        "revision",
        "sequence",
        "phase",
        "status",
        "reason",
        "allowedActions",
        "refusedActions",
        "receipt",
        "requester",
        "work",
        "next"
      ],
      "additionalProperties": false
    },
    "presentation": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "run-command",
            "answer-command-prompt",
            "change-files",
            "fetch",
            "start-agent",
            "hand-off-work",
            "change-setting",
            "mcp-tool",
            "other-tool",
            "purchase",
            "send-message",
            "question",
            "decision",
            "claim",
            "queued-action",
            "report"
          ]
        },
        "mark": {
          "type": "string",
          "enum": [
            "ask",
            "cannot-undo",
            "question"
          ]
        },
        "question": {
          "type": "string"
        },
        "place": {
          "type": "object",
          "properties": {
            "short": {
              "type": "string"
            },
            "full": {
              "type": "string"
            }
          },
          "required": [
            "short",
            "full"
          ],
          "additionalProperties": false
        },
        "subject": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "command",
                "paths",
                "urls",
                "text",
                "money"
              ]
            },
            "lines": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": [
            "kind",
            "lines"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string"
        },
        "consequence": {
          "type": "object",
          "properties": {
            "text": {
              "type": "string"
            },
            "withPlace": {
              "type": "string"
            },
            "tone": {
              "type": "string",
              "enum": [
                "plain",
                "cannot-undo"
              ]
            }
          },
          "required": [
            "text",
            "withPlace",
            "tone"
          ],
          "additionalProperties": false
        },
        "choices": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "label": {
                "type": "string"
              },
              "key": {
                "type": "string"
              },
              "default": {
                "type": "boolean"
              },
              "danger": {
                "type": "boolean"
              },
              "value": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "label"
            ],
            "additionalProperties": false
          }
        },
        "remember": {
          "type": "object",
          "properties": {
            "offered": {
              "type": "boolean"
            },
            "tiers": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "tier": {
                    "type": "string"
                  },
                  "label": {
                    "type": "string"
                  },
                  "detail": {
                    "type": "string"
                  }
                },
                "required": [
                  "tier",
                  "label",
                  "detail"
                ],
                "additionalProperties": false
              }
            },
            "why": {
              "type": "string"
            }
          },
          "required": [
            "offered"
          ],
          "additionalProperties": false
        },
        "typeToRefuse": {
          "type": "boolean"
        },
        "countdown": {
          "type": "object",
          "properties": {
            "verb": {
              "type": "string"
            },
            "at": {
              "type": "number"
            }
          },
          "required": [
            "verb",
            "at"
          ],
          "additionalProperties": false
        },
        "origin": {
          "type": "object",
          "properties": {
            "sessionTitle": {
              "type": "string"
            },
            "by": {
              "type": "string"
            }
          },
          "required": [
            "by"
          ],
          "additionalProperties": false
        },
        "why": {
          "type": "string"
        },
        "details": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string"
              },
              "value": {
                "type": "string"
              }
            },
            "required": [
              "label",
              "value"
            ],
            "additionalProperties": false
          }
        },
        "title": {
          "type": "string"
        }
      },
      "required": [
        "kind",
        "mark",
        "question",
        "choices",
        "remember",
        "typeToRefuse",
        "why",
        "details",
        "title"
      ],
      "additionalProperties": false
    },
    "createdAt": {
      "type": "number"
    }
  },
  "required": [
    "approval",
    "createdAt"
  ],
  "additionalProperties": false
}
```

#### `control.owner_inbox_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "item": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "approval",
            "question",
            "claim",
            "purchase",
            "queued-action",
            "decision",
            "report"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "open",
            "answered",
            "withdrawn",
            "expired"
          ]
        },
        "sessionId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "detail": {
          "type": "string"
        },
        "options": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "askedBy": {
          "type": "string"
        },
        "createdAt": {
          "type": "number"
        },
        "expiresAt": {
          "type": "number"
        },
        "answer": {
          "type": "object",
          "properties": {
            "option": {
              "type": "string"
            },
            "text": {
              "type": "string"
            }
          },
          "additionalProperties": false
        },
        "answeredBy": {
          "type": "object",
          "properties": {
            "actor": {
              "type": "string"
            },
            "surface": {
              "type": "string"
            }
          },
          "required": [
            "actor",
            "surface"
          ],
          "additionalProperties": false
        },
        "closedAt": {
          "type": "number"
        },
        "withdrawnReason": {
          "type": "string"
        },
        "key": {
          "type": "string"
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "object",
                "additionalProperties": {}
              },
              {
                "type": "array",
                "items": {}
              }
            ]
          }
        },
        "delivery": {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "delivered",
                "waiting",
                "undeliverable"
              ]
            },
            "to": {
              "type": "string"
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "state",
            "to"
          ],
          "additionalProperties": false
        },
        "revision": {
          "type": "number"
        },
        "reading": {
          "type": "object",
          "properties": {
            "ref": {
              "type": "object",
              "properties": {
                "node": {
                  "type": "string"
                },
                "id": {
                  "type": "string"
                }
              },
              "required": [
                "node",
                "id"
              ],
              "additionalProperties": false
            },
            "revision": {
              "type": "number"
            },
            "sequence": {
              "type": "number"
            },
            "phase": {
              "type": "string",
              "enum": [
                "waiting",
                "decided",
                "ended"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "claimed",
                "approved",
                "denied",
                "cancelled",
                "expired"
              ]
            },
            "reason": {
              "type": "string",
              "enum": [
                "waiting-for-approver",
                "waiting-for-owner",
                "claimed-by-you",
                "claimed-by-other",
                "approved",
                "denied",
                "amended",
                "remembered-approved",
                "remembered-denied",
                "cancelled-requester-left",
                "cancelled-requester-restarted",
                "cancelled-by-actor",
                "cancelled-owner-decision-stale",
                "expired",
                "expired-while-down"
              ]
            },
            "waitingOn": {
              "type": "object",
              "properties": {
                "who": {
                  "type": "string",
                  "enum": [
                    "owner",
                    "approver"
                  ]
                },
                "claimedBy": {
                  "type": "string"
                },
                "homeNode": {
                  "type": "string"
                },
                "homeReachable": {
                  "type": "boolean"
                }
              },
              "required": [
                "who",
                "homeNode",
                "homeReachable"
              ],
              "additionalProperties": false
            },
            "deadline": {
              "type": "object",
              "properties": {
                "expiresAt": {
                  "type": "number"
                },
                "remainingMs": {
                  "type": "number"
                }
              },
              "required": [
                "expiresAt",
                "remainingMs"
              ],
              "additionalProperties": false
            },
            "allowedActions": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "claim",
                  "approve",
                  "deny",
                  "amend",
                  "cancel"
                ]
              }
            },
            "refusedActions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "action": {
                    "type": "string",
                    "enum": [
                      "claim",
                      "approve",
                      "deny",
                      "amend",
                      "cancel"
                    ]
                  },
                  "code": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string"
                  }
                },
                "required": [
                  "action",
                  "code",
                  "reason"
                ],
                "additionalProperties": false
              }
            },
            "decision": {
              "type": "object",
              "properties": {
                "disposition": {
                  "type": "string",
                  "enum": [
                    "approved",
                    "denied",
                    "amended",
                    "cancelled",
                    "expired",
                    "remembered"
                  ]
                },
                "by": {
                  "type": "string"
                },
                "surface": {
                  "type": "string"
                },
                "node": {
                  "type": "string"
                },
                "at": {
                  "type": "number"
                },
                "cause": {
                  "type": "string",
                  "enum": [
                    "requester-left",
                    "requester-restarted",
                    "cancelled-by-actor",
                    "owner-decision-stale",
                    "deadline",
                    "deadline-while-down",
                    "remembered-rule"
                  ]
                }
              },
              "required": [
                "disposition",
                "by",
                "surface",
                "node",
                "at"
              ],
              "additionalProperties": false
            },
            "receipt": {
              "type": "object",
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "delivered",
                    "waiting",
                    "undeliverable",
                    "requester-reads-record",
                    "not-applicable"
                  ]
                },
                "reason": {
                  "type": "string"
                }
              },
              "required": [
                "state"
              ],
              "additionalProperties": false
            },
            "requester": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "in-process",
                    "wire",
                    "record-reader"
                  ]
                },
                "principal": {
                  "type": "string"
                },
                "surface": {
                  "type": "string"
                },
                "mine": {
                  "type": "boolean"
                }
              },
              "required": [
                "kind",
                "mine"
              ],
              "additionalProperties": false
            },
            "work": {
              "type": "object",
              "properties": {
                "state": {
                  "type": "string",
                  "enum": [
                    "not-reported"
                  ]
                },
                "callId": {
                  "type": "string"
                },
                "sessionId": {
                  "type": "string"
                }
              },
              "required": [
                "state",
                "callId"
              ],
              "additionalProperties": false
            },
            "next": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "move": {
                    "type": "string",
                    "enum": [
                      "wait",
                      "decide",
                      "refresh",
                      "raise-again",
                      "nothing"
                    ]
                  },
                  "text": {
                    "type": "string"
                  }
                },
                "required": [
                  "move",
                  "text"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "ref",
            "revision",
            "sequence",
            "phase",
            "status",
            "reason",
            "allowedActions",
            "refusedActions",
            "receipt",
            "requester",
            "work",
            "next"
          ],
          "additionalProperties": false
        },
        "presentation": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "run-command",
                "answer-command-prompt",
                "change-files",
                "fetch",
                "start-agent",
                "hand-off-work",
                "change-setting",
                "mcp-tool",
                "other-tool",
                "purchase",
                "send-message",
                "question",
                "decision",
                "claim",
                "queued-action",
                "report"
              ]
            },
            "mark": {
              "type": "string",
              "enum": [
                "ask",
                "cannot-undo",
                "question"
              ]
            },
            "question": {
              "type": "string"
            },
            "place": {
              "type": "object",
              "properties": {
                "short": {
                  "type": "string"
                },
                "full": {
                  "type": "string"
                }
              },
              "required": [
                "short",
                "full"
              ],
              "additionalProperties": false
            },
            "subject": {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "enum": [
                    "command",
                    "paths",
                    "urls",
                    "text",
                    "money"
                  ]
                },
                "lines": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "required": [
                "kind",
                "lines"
              ],
              "additionalProperties": false
            },
            "body": {
              "type": "string"
            },
            "consequence": {
              "type": "object",
              "properties": {
                "text": {
                  "type": "string"
                },
                "withPlace": {
                  "type": "string"
                },
                "tone": {
                  "type": "string",
                  "enum": [
                    "plain",
                    "cannot-undo"
                  ]
                }
              },
              "required": [
                "text",
                "withPlace",
                "tone"
              ],
              "additionalProperties": false
            },
            "choices": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "label": {
                    "type": "string"
                  },
                  "key": {
                    "type": "string"
                  },
                  "default": {
                    "type": "boolean"
                  },
                  "danger": {
                    "type": "boolean"
                  },
                  "value": {
                    "type": "string"
                  }
                },
                "required": [
                  "id",
                  "label"
                ],
                "additionalProperties": false
              }
            },
            "remember": {
              "type": "object",
              "properties": {
                "offered": {
                  "type": "boolean"
                },
                "tiers": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "tier": {
                        "type": "string"
                      },
                      "label": {
                        "type": "string"
                      },
                      "detail": {
                        "type": "string"
                      }
                    },
                    "required": [
                      "tier",
                      "label",
                      "detail"
                    ],
                    "additionalProperties": false
                  }
                },
                "why": {
                  "type": "string"
                }
              },
              "required": [
                "offered"
              ],
              "additionalProperties": false
            },
            "typeToRefuse": {
              "type": "boolean"
            },
            "countdown": {
              "type": "object",
              "properties": {
                "verb": {
                  "type": "string"
                },
                "at": {
                  "type": "number"
                }
              },
              "required": [
                "verb",
                "at"
              ],
              "additionalProperties": false
            },
            "origin": {
              "type": "object",
              "properties": {
                "sessionTitle": {
                  "type": "string"
                },
                "by": {
                  "type": "string"
                }
              },
              "required": [
                "by"
              ],
              "additionalProperties": false
            },
            "why": {
              "type": "string"
            },
            "details": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "label": {
                    "type": "string"
                  },
                  "value": {
                    "type": "string"
                  }
                },
                "required": [
                  "label",
                  "value"
                ],
                "additionalProperties": false
              }
            },
            "title": {
              "type": "string"
            }
          },
          "required": [
            "kind",
            "mark",
            "question",
            "choices",
            "remember",
            "typeToRefuse",
            "why",
            "details",
            "title"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "id",
        "kind",
        "status",
        "title",
        "detail",
        "options",
        "createdAt"
      ],
      "additionalProperties": false
    },
    "createdAt": {
      "type": "number"
    }
  },
  "required": [
    "item",
    "createdAt"
  ],
  "additionalProperties": false
}
```

#### `runtime.gate` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `knowledge`

- `runtime.knowledge` -> `knowledge`

#### `runtime.knowledge` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `mcp`

- `runtime.mcp` -> `mcp`

#### `runtime.mcp` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `ops`

- `runtime.ops` -> `ops`

#### `runtime.ops` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `planner`

- `runtime.planner` -> `planner`

#### `runtime.planner` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `plugins`

- `runtime.plugins` -> `plugins`

#### `runtime.plugins` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `providers`

- `runtime.providers` -> `providers`

#### `runtime.providers` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `routes`

- `runtime.routes` -> `routes`

#### `runtime.routes` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `security`

- `runtime.security` -> `security`

#### `runtime.security` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `session`

- `control.hosted_session_update` -> `hosted-session-update`
- `control.session_update` -> `session-update`
- `runtime.session` -> `session`

#### `control.hosted_session_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "event": {
      "type": "string",
      "enum": [
        "hosted-session-created",
        "hosted-session-attached",
        "hosted-session-detached",
        "hosted-session-turn-started",
        "hosted-session-turn-ended",
        "hosted-session-terminated",
        "hosted-session-restored",
        "hosted-session-contract-started",
        "hosted-session-contract-notice"
      ]
    },
    "session": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "nativeConversation": {
          "type": "boolean",
          "const": true
        },
        "workspaceRoot": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "idle",
            "running",
            "terminated"
          ]
        },
        "detachPolicy": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "kill",
                "survive"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "effectiveDetachPolicy": {
          "type": "string",
          "enum": [
            "kill",
            "survive"
          ]
        },
        "attachedClients": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "providerId": {
          "type": "string"
        },
        "modelId": {
          "type": "string"
        },
        "createdAt": {
          "type": "number"
        },
        "updatedAt": {
          "type": "number"
        },
        "turnCount": {
          "type": "number"
        },
        "messageCount": {
          "type": "number"
        },
        "lastTurnAt": {
          "type": "number"
        },
        "terminatedAt": {
          "type": "number"
        },
        "terminatedReason": {
          "type": "string"
        },
        "restoredFromDisk": {
          "type": "boolean"
        },
        "originSurface": {
          "type": "string"
        },
        "permissionMode": {
          "type": "string",
          "enum": [
            "ask-me",
            "jev-decides",
            "just-vibes",
            "yolo",
            "plan"
          ]
        },
        "contractIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "saveError": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "workspaceRoot",
        "title",
        "status",
        "detachPolicy",
        "effectiveDetachPolicy",
        "attachedClients",
        "createdAt",
        "updatedAt",
        "turnCount",
        "messageCount",
        "restoredFromDisk",
        "contractIds"
      ],
      "additionalProperties": false
    },
    "createdAt": {
      "type": "number"
    },
    "clientId": {
      "type": "string"
    },
    "detail": {
      "type": "string"
    }
  },
  "required": [
    "event",
    "session",
    "createdAt"
  ],
  "additionalProperties": false
}
```

#### `control.session_update` payload schema

```json
{
  "type": "object",
  "properties": {
    "event": {
      "type": "string",
      "enum": [
        "session-created",
        "session-closed",
        "session-deleted",
        "session-reopened",
        "session-permission-mode-changed",
        "session-agent-bound",
        "session-agent-completed",
        "session-message-appended",
        "session-message-forwarded",
        "session-route-attached",
        "session-detached",
        "session-input-queued",
        "session-input-queued-for-surface",
        "session-input-delivered",
        "session-input-spawned",
        "session-input-completed",
        "session-input-failed",
        "session-input-rejected",
        "session-input-cancelled",
        "session-follow-up-queued",
        "session-follow-up-spawned"
      ]
    },
    "payload": {
      "type": "object",
      "additionalProperties": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "number"
          },
          {
            "type": "boolean"
          },
          {
            "type": "null"
          },
          {},
          {
            "type": "array",
            "items": {}
          }
        ]
      }
    },
    "createdAt": {
      "type": "number"
    }
  },
  "required": [
    "event",
    "payload",
    "createdAt"
  ],
  "additionalProperties": false
}
```

#### `runtime.session` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `surfaces`

- `runtime.surfaces` -> `surfaces`

#### `runtime.surfaces` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `tasks`

- `runtime.tasks` -> `tasks`

#### `runtime.tasks` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `tools`

- `runtime.tools` -> `tools`

#### `runtime.tools` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `transport`

- `runtime.transport` -> `transport`

#### `runtime.transport` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `turn`

- `runtime.turn` -> `turn`

#### `runtime.turn` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `ui`

- `runtime.ui` -> `ui`

#### `runtime.ui` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `watchers`

- `runtime.watchers` -> `watchers`

#### `runtime.watchers` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

### `workspace`

- `runtime.workspace` -> `workspace`

#### `runtime.workspace` payload schema

```json
{
  "type": "object",
  "additionalProperties": {
    "anyOf": [
      {
        "type": "string"
      },
      {
        "type": "number"
      },
      {
        "type": "boolean"
      },
      {
        "type": "null"
      },
      {},
      {
        "type": "array",
        "items": {}
      }
    ]
  }
}
```

## Named contract events

The `contracts` domain carries one named event per step of a contract. Each field below is required unless marked optional.

### `CONTRACT_CREATED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `sessionId` | string | yes |
| `origin` | enum: `agent-tool`, `cli`, `external`, `hosted`, `proposal`, `turn` | yes |
| `ask` | string | yes |
| `ownerAgentId` | string | yes |
| `gateProblems` | string[] | optional |
| `occurrenceId` | string | optional |

### `CONTRACT_STATUS_CHANGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `from` | enum: `awaiting-owner`, `cancelled`, `checking-plan`, `committing`, `failed`, `fixing`, `judging`, `passed`, `planning`, `queued`, `running`, `shaping` | yes |
| `to` | enum: `awaiting-owner`, `cancelled`, `checking-plan`, `committing`, `failed`, `fixing`, `judging`, `passed`, `planning`, `queued`, `running`, `shaping` | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_SHAPED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `forbidsDelegation` | object | yes |
| `forbidsDelegation.verdict` | enum: `no`, `uncertain`, `yes` | yes |
| `forbidsDelegation.probability` | number | yes |
| `forbidsDelegation.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `requestsParallelAgents` | object | yes |
| `requestsParallelAgents.verdict` | enum: `no`, `uncertain`, `yes` | yes |
| `requestsParallelAgents.probability` | number | yes |
| `requestsParallelAgents.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `forbidsWriting` | object | yes |
| `forbidsWriting.verdict` | enum: `no`, `uncertain`, `yes` | yes |
| `forbidsWriting.probability` | number | yes |
| `forbidsWriting.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `asksForAttempts` | object | yes |
| `asksForAttempts.verdict` | enum: `no`, `uncertain`, `yes` | yes |
| `asksForAttempts.probability` | number | yes |
| `asksForAttempts.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `decisionIds` | string[] | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_PLANNED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `goal` | string | yes |
| `criteria` | object[] | yes |
| `criteria[].id` | string | yes |
| `criteria[].text` | string | yes |
| `criteria[].origin` | enum: `derived`, `fix`, `integration`, `owner`, `stated` | yes |
| `criteria[].quote` | string | optional |
| `criteria[].serves` | string[] | yes |
| `criteria[].disposition` | enum: `excluded`, `judged`, `met-by-structure` | yes |
| `criteria[].dispositionReason` | string | optional |
| `groups` | object[] | yes |
| `groups[].id` | string | yes |
| `groups[].title` | string | yes |
| `groups[].kind` | enum: `fix`, `integration`, `work` | yes |
| `groups[].dependsOn` | string[] | yes |
| `groups[].unitIds` | string[] | yes |
| `units` | object[] | yes |
| `units[].id` | string | yes |
| `units[].groupId` | string | yes |
| `units[].title` | string | yes |
| `units[].role` | enum: `design`, `implement`, `integration`, `research` | yes |
| `units[].dependsOn` | string[] | yes |
| `units[].attempts` | number | yes |
| `repair` | number | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_PLAN_CHECKED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `check` | enum: `criterion-shape`, `criterion-trace`, `plan-coverage`, `structure`, `unit-shape` | yes |
| `targetId` | string | optional |
| `passed` | boolean | yes |
| `problems` | object[] | yes |
| `problems[].code` | string | yes |
| `problems[].targetId` | string | optional |
| `problems[].message` | string | yes |
| `decisionIds` | string[] | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_GROUP_STATUS_CHANGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `groupId` | string | yes |
| `from` | enum: `awaiting-owner`, `blocked`, `cancelled`, `failed`, `fixing`, `judging`, `passed`, `pending`, `running` | yes |
| `to` | enum: `awaiting-owner`, `blocked`, `cancelled`, `failed`, `fixing`, `judging`, `passed`, `pending`, `running` | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_UNIT_STATUS_CHANGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `groupId` | string | yes |
| `unitId` | string | yes |
| `from` | enum: `awaiting-owner`, `blocked`, `cancelled`, `checking`, `failed`, `fixing`, `held`, `held-merge`, `nudged`, `passed`, `pending`, `running` | yes |
| `to` | enum: `awaiting-owner`, `blocked`, `cancelled`, `checking`, `failed`, `fixing`, `held`, `held-merge`, `nudged`, `passed`, `pending`, `running` | yes |
| `agentId` | string | optional |
| `occurrenceId` | string | optional |

### `CONTRACT_UNIT_SPAWNED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `agentId` | string | yes |
| `route` | object | yes |
| `route.model` | string | yes |
| `route.provider` | string | yes |
| `route.reasoningEffort` | string | optional |
| `route.reason` | string | yes |
| `purpose` | enum: `fresh-unit`, `resume`, `silence-retry`, `transport-retry`, `unit` | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_CHECKED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `scope` | enum: `deliverable`, `group`, `unit` | yes |
| `targetId` | string | yes |
| `checkId` | string | yes |
| `trigger` | enum: `agent-failed`, `completion`, `fix-passed`, `owner-amend`, `resume`, `turn-end` | yes |
| `result` | enum: `await-owner`, `native-decision`, `nudge`, `pass`, `recorded`, `stall` | yes |
| `criteria` | object[] | yes |
| `criteria[].criterionId` | string | yes |
| `criteria[].verdict` | enum: `met`, `unmet`, `unshown` | yes |
| `criteria[].probabilityUnmet` | number | yes |
| `criteria[].outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `goal` | object | yes |
| `goal.verdict` | enum: `met`, `unmet`, `unshown` | yes |
| `goal.outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `quality` | object[] | yes |
| `quality[].item` | enum: `breaks_existing`, `hidden_failure`, `out_of_scope`, `placeholder`, `tests_weakened`, `unsupported_claims` | yes |
| `quality[].verdict` | enum: `no`, `uncertain`, `yes` | yes |
| `quality[].outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `gates` | object[] | yes |
| `gates[].gate` | string | yes |
| `gates[].passed` | boolean | yes |
| `gates[].skipped` | boolean | yes |
| `gates[].outcome` | enum: `failed`, `passed`, `unverified` | optional |
| `gates[].required` | boolean | optional |
| `gates[].reason` | string | optional |
| `claims` | enum: `files_verified`, `git_corroborated`, `unverifiable_no_claims`, `unverified`, `verified_empty` | optional |
| `decisionIds` | string[] | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_NUDGED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `nudgeId` | string | yes |
| `checkId` | string | yes |
| `kinds` | enum[]: `claims`, `gate`, `quality`, `regression`, `unmet`, `unshown` | yes |
| `criterionIds` | string[] | yes |
| `delivery` | enum: `bus`, `hold`, `wake` | yes |
| `agentId` | string | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_NUDGE_CONSUMED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `nudgeId` | string | yes |
| `agentId` | string | yes |
| `turn` | number | optional |
| `occurrenceId` | string | optional |

### `CONTRACT_CRITERION_REGRESSED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `criterionId` | string | yes |
| `metAtCheckId` | string | yes |
| `checkId` | string | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_STALLED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `scope` | enum: `deliverable`, `group`, `unit` | yes |
| `targetId` | string | yes |
| `route` | enum: `fresh`, `owner`, `split` | yes |
| `unmetCriterionIds` | string[] | yes |
| `reason` | string | yes |
| `decisionId` | string | optional |
| `occurrenceId` | string | optional |

### `CONTRACT_FIX_PLANNED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `scope` | enum: `deliverable`, `group`, `unit` | yes |
| `targetId` | string | yes |
| `groupId` | string | yes |
| `unitIds` | string[] | yes |
| `round` | number | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_ESCALATED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `escalationId` | string | yes |
| `scope` | enum: `deliverable`, `group`, `plan`, `shape`, `unit` | yes |
| `targetId` | string | yes |
| `reason` | enum: `attempts-undecided`, `fix-rounds-exhausted`, `owner-decision-needed`, `plan-unresolved`, `stalled`, `unsettled`, `writing-unclear` | yes |
| `question` | string | yes |
| `unmetCriterionIds` | string[] | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_OWNER_REPLIED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `escalationId` | string | yes |
| `reading` | enum: `amend`, `approve`, `reject`, `unclear` | yes |
| `outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `action` | enum: `amended`, `approved`, `asked-again`, `refused`, `stopped` | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_WAITING`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `reason` | string | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_GATE_RESULT`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `targetId` | string | yes |
| `gate` | string | yes |
| `passed` | boolean | yes |
| `skipped` | boolean | yes |
| `durationMs` | number | yes |
| `outcome` | enum: `failed`, `passed`, `unverified` | optional |
| `required` | boolean | optional |
| `reason` | string | optional |
| `occurrenceId` | string | optional |

### `CONTRACT_UNIT_SILENT`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `agentId` | string | yes |
| `silentMs` | number | yes |
| `action` | enum: `failed`, `retried` | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_MERGE_CONFLICT`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `branch` | string | yes |
| `path` | string | yes |
| `files` | string[] | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_ATTEMPTS_SELECTED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `unitId` | string | yes |
| `candidateIds` | string[] | yes |
| `chosen` | string|null | yes |
| `outcome` | enum: `act`, `confirm`, `escalate` | yes |
| `decisionId` | string | optional |
| `occurrenceId` | string | optional |

### `CONTRACT_COMMITTED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `status` | enum: `applied`, `committed`, `failed`, `skipped` | yes |
| `hash` | string | optional |
| `note` | string | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_PASSED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `criteriaMet` | number | yes |
| `criteriaJudged` | number | yes |
| `excluded` | number | yes |
| `nudges` | number | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_FAILED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `reason` | string | yes |
| `failureKind` | enum: `budget`, `judgment-unavailable`, `max_turns`, `other`, `owner-rejected`, `planning`, `transport`, `zombie` | yes |
| `membersSettled` | boolean | yes |
| `turnLimit` | number | optional |
| `turnLimitSource` | enum: `default`, `policy-bound`, `spawn-override` | optional |
| `occurrenceId` | string | optional |

### `CONTRACT_CANCELLED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | yes |
| `reason` | string | yes |
| `filesModified` | number | yes |
| `occurrenceId` | string | optional |

### `CONTRACT_SPAWN_GUARD_TRIGGERED`

| Field | Type | Required |
|-------|------|----------|
| `contractId` | string | optional |
| `agentId` | string | yes |
| `depth` | number | yes |
| `activeAgents` | number | yes |
| `reason` | string | yes |
| `occurrenceId` | string | optional |

