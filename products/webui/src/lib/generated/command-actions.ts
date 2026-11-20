// GENERATED FILE: DO NOT EDIT BY HAND.
// Regenerate with `bun run release:prepare` (scripts/generate-command-actions.ts),
// from the engine's contracts/artifacts/command-actions.json.
import type { CommandActionsSnapshot } from '../command-actions-types';

export const COMMAND_ACTIONS: CommandActionsSnapshot = {
  "commands": [
    {
      "name": "accounts",
      "title": "Accounts",
      "summary": "Your model provider accounts, and signing in to a GoodVibes daemon or listener",
      "group": "Models",
      "report": "see-accounts",
      "actions": [
        {
          "id": "see-accounts",
          "label": "See your provider accounts",
          "word": "review",
          "line": "/accounts review",
          "sentence": "Shows each model provider, how it is reached now and which way is preferred, how fresh its sign-in is, and anything wrong.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "accounts.snapshot",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "see-account",
          "label": "See one provider's account",
          "word": "show",
          "line": "/accounts show <provider>",
          "sentence": "Shows {provider}'s account: each way it can be reached, its sign-in, usage windows and what to do next.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "accounts.snapshot",
            "fields": {}
          },
          "inputs": [
            {
              "id": "provider",
              "label": "Provider",
              "help": "The model providers you have",
              "kind": "choice",
              "choices": {
                "list": "accounts.providers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "see-routes",
          "label": "See how a provider is reached",
          "word": "routes",
          "line": "/accounts routes <provider>",
          "sentence": "Shows each way {provider} can be reached (a key, a subscription, a local server), whether it works, and why one is used.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "accounts.snapshot",
            "fields": {}
          },
          "inputs": [
            {
              "id": "provider",
              "label": "Provider",
              "help": "The model providers you have",
              "kind": "choice",
              "choices": {
                "list": "accounts.providers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "fix-account",
          "label": "See how to fix a provider's account",
          "word": "repair",
          "line": "/accounts repair <provider>",
          "sentence": "Shows what is wrong with {provider}'s account and the steps that fix it.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "accounts.snapshot",
            "fields": {}
          },
          "inputs": [
            {
              "id": "provider",
              "label": "Provider",
              "help": "The model providers you have",
              "kind": "choice",
              "choices": {
                "list": "accounts.providers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "open-screen",
          "label": "Open the providers screen",
          "word": "open",
          "line": "/accounts open",
          "sentence": "Opens the full-screen view of your providers and their accounts.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "sign-in",
          "label": "Sign in to a daemon or listener",
          "word": "sign-in",
          "line": "/accounts sign-in <service> <address> [--user <user name>] [--password <password>] [--key <kept as>]",
          "sentence": "Your password for {user} will be sent to {address} to sign in to the {service}; the session it gives is kept until you change it (signing out ends it).",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "sends-out",
          "riskWords": "sends something outside this machine",
          "undoneBy": "sign-out",
          "operator": {
            "terminalOnly": "A session is kept by the terminal app that signs in."
          },
          "inputs": [
            {
              "id": "service",
              "label": "Service",
              "help": "A daemon or a listener",
              "kind": "choice",
              "choices": [
                {
                  "value": "daemon",
                  "label": "A daemon",
                  "help": "The GoodVibes service that runs sessions, on this machine or another"
                },
                {
                  "value": "listener",
                  "label": "A listener",
                  "help": "A GoodVibes listener that receives messages from channels"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "address",
              "label": "Address",
              "help": "Its web address, such as https://host.example:3421",
              "kind": "text",
              "freeTextReason": "the address the service answers at",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "user",
              "label": "User name",
              "help": "The name you sign in with there",
              "kind": "text",
              "freeTextReason": "your user name on that service",
              "required": true,
              "typed": {
                "flag": "--user"
              }
            },
            {
              "id": "password",
              "label": "Password",
              "help": "Hidden as you type; sent only to the address you gave",
              "kind": "secret",
              "required": true,
              "typed": {
                "flag": "--password"
              }
            },
            {
              "id": "key",
              "label": "Kept as",
              "help": "The name a listener session is kept under in your secret store",
              "kind": "text",
              "freeTextReason": "a secret name you choose",
              "required": {
                "default": "",
                "defaultMeans": "LISTENER_SESSION_TOKEN"
              },
              "typed": {
                "flag": "--key"
              }
            }
          ]
        },
        {
          "id": "sign-out",
          "label": "Sign out of a daemon or listener",
          "word": "sign-out",
          "line": "/accounts sign-out <service> <address> [--key <kept as>]",
          "sentence": "The {service} at {address} will be asked to end your session, and this terminal forgets it, until you change it (signing in starts a new one).",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "sign-in",
          "operator": {
            "terminalOnly": "A session is kept by the terminal app that signed in."
          },
          "inputs": [
            {
              "id": "service",
              "label": "Service",
              "help": "A daemon or a listener",
              "kind": "choice",
              "choices": [
                {
                  "value": "daemon",
                  "label": "A daemon",
                  "help": "The GoodVibes service that runs sessions, on this machine or another"
                },
                {
                  "value": "listener",
                  "label": "A listener",
                  "help": "A GoodVibes listener that receives messages from channels"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "address",
              "label": "Address",
              "help": "Its web address, such as https://host.example:3421",
              "kind": "text",
              "freeTextReason": "the address the service answers at",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "key",
              "label": "Kept as",
              "help": "The name a listener session is kept under in your secret store",
              "kind": "text",
              "freeTextReason": "a secret name you choose",
              "required": {
                "default": "",
                "defaultMeans": "LISTENER_SESSION_TOKEN"
              },
              "typed": {
                "flag": "--key"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "auth",
      "title": "Provider sign-ins",
      "summary": "See how you are signed in to model providers and how to fix a sign-in",
      "group": "Setup",
      "report": "see-sign-ins",
      "actions": [
        {
          "id": "see-sign-ins",
          "label": "See your provider sign-ins",
          "word": "review",
          "line": "/auth review",
          "sentence": "Shows each provider you can sign in to, whether you are signed in, and when it ends.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "accounts.snapshot",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "see-sign-in",
          "label": "See one provider's sign-in",
          "word": "show",
          "line": "/auth show <provider>",
          "sentence": "Shows how {provider} is signed in: where its settings come from, the token's type and end, and anything wrong; no token is shown.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Provider sign-ins are read from the terminal app's own stores."
          },
          "inputs": [
            {
              "id": "provider",
              "label": "Provider",
              "help": "Providers you can sign in to with a subscription",
              "kind": "choice",
              "choices": {
                "list": "auth.providers",
                "allowOther": {
                  "reason": "a provider a services file adds"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "fix-sign-in",
          "label": "See how to fix a provider's sign-in",
          "word": "repair",
          "line": "/auth repair <provider>",
          "sentence": "Shows what is wrong with {provider}'s sign-in and the steps that fix it.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The steps name terminal commands."
          },
          "inputs": [
            {
              "id": "provider",
              "label": "Provider",
              "help": "Providers you can sign in to with a subscription",
              "kind": "choice",
              "choices": {
                "list": "auth.providers",
                "allowOther": {
                  "reason": "a provider a services file adds"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "save-summary",
          "label": "Save a sign-in summary to a file",
          "word": "export",
          "line": "/auth export <file> [--replace]",
          "sentence": "A summary of your sign-ins (names of stored secrets and providers, no secret or token) will be written to {path}, readable by you only, until you change it.",
          "done": "Saved the sign-in summary to {path}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written on the terminal app's machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A path in this project, or an absolute path",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "replace",
              "label": "If the file exists",
              "help": "Keep it, or write over it",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "Keep it and stop",
                  "help": "Nothing is written when the file is there."
                },
                {
                  "value": "yes",
                  "label": "Write over it",
                  "help": "What the file holds now is lost.",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "keep it and stop"
              },
              "typed": {
                "flag": "--replace",
                "switchOn": "yes"
              }
            }
          ]
        },
        {
          "id": "read-summary",
          "label": "Read a saved sign-in summary",
          "word": "inspect",
          "line": "/auth inspect <file>",
          "sentence": "Shows what the sign-in summary in {path} holds.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is read on the terminal app's machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A path in this project, or an absolute path",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "cluster",
      "title": "Cluster",
      "summary": "Share inbound channel work with your other goodvibes machines on this network",
      "group": "Devices",
      "report": "status",
      "actions": [
        {
          "id": "status",
          "label": "See this machine's group",
          "word": "status",
          "line": "/cluster status [--host <which machine>] [--token <its access token>]",
          "sentence": "Shows the group this machine is in, its members and its key's age.",
          "done": "",
          "touches": "another-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "groups",
          "label": "See the groups on this network",
          "word": "groups",
          "line": "/cluster groups [--host <which machine>] [--token <its access token>]",
          "sentence": "Shows the groups other machines on this network announce.",
          "done": "",
          "touches": "another-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "create",
          "label": "Start a group on this network",
          "word": "create",
          "line": "/cluster create [--name <group name>] [--passphrase <passphrase>] [--host <which machine>] [--token <its access token>]",
          "sentence": "A new group is started on this machine, until you change it; other machines join it with its key.",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "leave",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Group name",
              "help": "A name the other machines will see",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "this machine's name"
              },
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "passphrase",
              "label": "Passphrase",
              "help": "A phrase the join key is made from; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "a random key"
              },
              "typed": {
                "flag": "--passphrase"
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "join",
          "label": "Join a group",
          "word": "join",
          "line": "/cluster join <group> [--key <join key>] [--host <which machine>] [--token <its access token>]",
          "sentence": "This machine joins {group} and shares inbound channel work with its members, until you change it.",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "sends-out",
          "riskWords": "sends something outside this machine",
          "undoneBy": "leave",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "group",
              "label": "Group",
              "help": "The group's id, as /cluster groups shows it",
              "kind": "text",
              "freeTextReason": "the id another machine announced",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "key",
              "label": "Join key",
              "help": "The key /cluster key shows on a member; hidden as you type",
              "kind": "secret",
              "required": true,
              "typed": {
                "flag": "--key"
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "nodes",
          "label": "See the machines in the group",
          "word": "nodes",
          "line": "/cluster nodes [--host <which machine>] [--token <its access token>]",
          "sentence": "Shows each machine in the group, when it was last seen and what it serves.",
          "done": "",
          "touches": "another-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "key",
          "label": "See the key others join with",
          "word": "key",
          "line": "/cluster key [--qr] [--host <which machine>] [--token <its access token>]",
          "sentence": "Shows the group's join key; anyone with it can join the group.",
          "done": "",
          "touches": "credential",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "qr",
              "label": "Also as a QR code",
              "help": "Show the key as a QR code to scan",
              "kind": "yes-no",
              "choices": [
                {
                  "value": "no",
                  "label": "No"
                },
                {
                  "value": "yes",
                  "label": "Yes"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "text only"
              },
              "typed": {
                "flag": "--qr"
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "rename",
          "label": "Rename the group",
          "word": "rename",
          "line": "/cluster rename [--host <which machine>] [--token <its access token>] <new name...>",
          "sentence": "The group is named \"{name}\" on every machine, until you change it.",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "name",
              "label": "New name",
              "help": "The name the machines will see",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "rotate",
          "label": "Change the group's join key",
          "word": "rotate",
          "line": "/cluster rotate [--now] [--host <which machine>] [--token <its access token>]",
          "sentence": "The group gets a new join key, until you change it; machines pick it up on their own.",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "when",
              "label": "The old key",
              "help": "Whether the old key still works for a while",
              "kind": "choice",
              "choices": [
                {
                  "value": "grace",
                  "label": "Keeps working for a while"
                },
                {
                  "value": "now",
                  "label": "Stops working now",
                  "help": "A machine that has not picked up the new key is cut off.",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "grace",
                "defaultMeans": "keeps working for a while"
              },
              "typed": {
                "flag": "--now",
                "switchOn": "now"
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "forget",
          "label": "Remove a machine from the group",
          "word": "forget",
          "line": "/cluster forget <machine> [--host <which machine>] [--token <its access token>]",
          "sentence": "{node} is removed from the group and the group key is replaced at once.",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "node",
              "label": "Machine",
              "help": "The machine's name, as /cluster nodes shows it",
              "kind": "text",
              "freeTextReason": "a machine name from /cluster nodes",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "leave",
          "label": "Leave the group",
          "word": "leave",
          "line": "/cluster leave [--host <which machine>] [--token <its access token>]",
          "sentence": "This machine leaves its group; joining again needs the key.",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "publish",
          "label": "Share a setting with the group",
          "word": "publish",
          "line": "/cluster publish <shared setting> [--host <which machine>] [--token <its access token>]",
          "sentence": "{setting} on every machine in the group is replaced with this machine's value (for user:<name>, this machine's account becomes the group's and the others end).",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "setting",
              "label": "Shared setting",
              "help": "A shared setting's key, or user:<name> for an account",
              "kind": "text",
              "freeTextReason": "a shared setting's key or user:<name>",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        },
        {
          "id": "accept",
          "label": "Take the group's value of a setting",
          "word": "accept",
          "line": "/cluster accept <shared setting> [--host <which machine>] [--token <its access token>]",
          "sentence": "This machine's {setting} is replaced with the group's (for user:<name>, this machine's account of that name ends).",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The web UI has its own Cluster page on each daemon."
          },
          "inputs": [
            {
              "id": "setting",
              "label": "Shared setting",
              "help": "A shared setting's key, or user:<name> for an account",
              "kind": "text",
              "freeTextReason": "a shared setting's key or user:<name>",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "machine",
              "label": "Which machine",
              "help": "The daemon to act on: this machine, or another one's address (https://host:port)",
              "kind": "text",
              "freeTextReason": "the address of a daemon on another machine",
              "required": {
                "default": "",
                "defaultMeans": "this machine"
              },
              "typed": {
                "flag": "--host"
              }
            },
            {
              "id": "token",
              "label": "Its access token",
              "help": "Only for another machine whose token is not stored here; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "the token stored for it, if any"
              },
              "typed": {
                "flag": "--token"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "decisions",
      "title": "What was decided for you",
      "summary": "Calls Jev decided for you, and every answered inbox item: see them, undo one, or set a standing rule",
      "group": "Inbox",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See what was decided for you",
          "word": "list",
          "line": "/decisions list [--when <when>] [--count <how many>]",
          "sentence": "Lists the calls Jev decided that you can still change, and what was decided, {when}.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "when",
              "label": "When",
              "help": "today, yesterday, a day (2026-11-19), or since a day or 30m, 2h, 3d, 1w",
              "kind": "text",
              "freeTextReason": "a day or a time span",
              "required": {
                "default": "",
                "defaultMeans": "the latest"
              },
              "typed": {
                "flag": "--when"
              }
            },
            {
              "id": "count",
              "label": "How many",
              "help": "How many of the latest to show",
              "kind": "number",
              "freeTextReason": "a number",
              "required": {
                "default": "",
                "defaultMeans": "30"
              },
              "typed": {
                "flag": "--count"
              }
            }
          ]
        },
        {
          "id": "keep",
          "label": "Leave a decision as Jev made it",
          "word": "keep",
          "line": "/decisions keep <decision>",
          "sentence": "{decision} stays as Jev decided it, and nothing changes until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "what Jev decided for the owner is the owner's to change",
            "instead": "Ask the owner to choose it with /decisions keep."
          },
          "operator": {
            "terminalOnly": "The web UI answers the inbox on its own Inbox page."
          },
          "inputs": [
            {
              "id": "decision",
              "label": "Decision",
              "help": "Calls Jev decided that you can still change",
              "kind": "choice",
              "choices": {
                "list": "inbox.decisions"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "undo",
          "label": "Undo what a decision did",
          "word": "undo",
          "line": "/decisions undo <decision>",
          "sentence": "The files the call in {decision} changed are put back as they were before it, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "what Jev decided for the owner is the owner's to change",
            "instead": "Ask the owner to choose it with /decisions undo."
          },
          "operator": {
            "terminalOnly": "The web UI answers the inbox on its own Inbox page."
          },
          "inputs": [
            {
              "id": "decision",
              "label": "Decision",
              "help": "Calls Jev decided that you can still change",
              "kind": "choice",
              "choices": {
                "list": "inbox.decisions"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "never",
          "label": "Never allow calls like a decision's",
          "word": "never",
          "line": "/decisions never <decision>",
          "sentence": "Calls like the one in {decision} are refused from now on, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "what Jev decided for the owner is the owner's to change",
            "instead": "Ask the owner to choose it with /decisions never."
          },
          "operator": {
            "terminalOnly": "The web UI answers the inbox on its own Inbox page."
          },
          "inputs": [
            {
              "id": "decision",
              "label": "Decision",
              "help": "Calls Jev decided that you can still change",
              "kind": "choice",
              "choices": {
                "list": "inbox.decisions"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "always",
          "label": "Always allow calls like a decision's without asking",
          "word": "always",
          "line": "/decisions always <decision>",
          "sentence": "Calls like the one in {decision} run without asking from now on, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "what Jev decided for the owner is the owner's to change",
            "instead": "Ask the owner to choose it with /decisions always."
          },
          "operator": {
            "terminalOnly": "The web UI answers the inbox on its own Inbox page."
          },
          "inputs": [
            {
              "id": "decision",
              "label": "Decision",
              "help": "Calls Jev decided that you can still change",
              "kind": "choice",
              "choices": {
                "list": "inbox.decisions"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "ask",
          "label": "Ask me about calls like a decision's",
          "word": "ask",
          "line": "/decisions ask <decision>",
          "sentence": "Calls like the one in {decision} are asked of you from now on, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "what Jev decided for the owner is the owner's to change",
            "instead": "Ask the owner to choose it with /decisions ask."
          },
          "operator": {
            "terminalOnly": "The web UI answers the inbox on its own Inbox page."
          },
          "inputs": [
            {
              "id": "decision",
              "label": "Decision",
              "help": "Calls Jev decided that you can still change",
              "kind": "choice",
              "choices": {
                "list": "inbox.decisions"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "graph",
      "title": "Workstream task graph",
      "summary": "See how a workstream's steps depend on each other and where it is stuck",
      "group": "Work",
      "actions": [
        {
          "id": "graph",
          "label": "See a workstream's task graph",
          "word": "",
          "line": "/graph <workstream>",
          "sentence": "Shows {workstream}'s steps, what each waits on, which are stuck, and how many run at once.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "fleet.graph.get",
            "fields": {
              "workstreamId": "workstream"
            }
          },
          "inputs": [
            {
              "id": "workstream",
              "label": "Workstream",
              "help": "The workstreams the daemon knows",
              "kind": "choice",
              "choices": {
                "list": "fleet.workstreams",
                "allowOther": {
                  "reason": "a workstream id from /workstream list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "held",
      "title": "Held calls",
      "summary": "Calls just-vibes held for you instead of asking: approve them or set them aside",
      "group": "Permissions",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See the calls held for you",
          "word": "list",
          "line": "/held list",
          "sentence": "Lists the calls just-vibes held instead of asking you, with why each was held.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "approve",
          "label": "Approve a held call",
          "word": "approve",
          "line": "/held approve <held calls...>",
          "sentence": "{calls} may run for this session only, when the work carries on.",
          "done": "",
          "touches": "this-machine",
          "lasts": "session",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "the answer to a held call is the owner's",
            "instead": "Ask the owner to approve it with /held approve."
          },
          "operator": {
            "terminalOnly": "Held calls belong to the terminal session that held them."
          },
          "inputs": [
            {
              "id": "calls",
              "label": "Held calls",
              "help": "The calls held for you; several ids separated by spaces, or all",
              "kind": "choice",
              "choices": {
                "list": "held-calls",
                "allowOther": {
                  "reason": "several ids separated by spaces, or all"
                }
              },
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "dismiss",
          "label": "Set a held call aside",
          "word": "dismiss",
          "line": "/held dismiss <held calls...>",
          "sentence": "{calls} is set aside and not run, for this session only; the model may make the call again.",
          "done": "",
          "touches": "this-machine",
          "lasts": "session",
          "risk": "none",
          "ownerOnly": {
            "reason": "the answer to a held call is the owner's",
            "instead": "Ask the owner to set it aside with /held dismiss."
          },
          "operator": {
            "terminalOnly": "Held calls belong to the terminal session that held them."
          },
          "inputs": [
            {
              "id": "calls",
              "label": "Held calls",
              "help": "The calls held for you; several ids separated by spaces, or all",
              "kind": "choice",
              "choices": {
                "list": "held-calls",
                "allowOther": {
                  "reason": "several ids separated by spaces, or all"
                }
              },
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        }
      ]
    },
    {
      "name": "hooks",
      "title": "Hooks",
      "summary": "Run your own steps when things happen: before a tool runs, after a turn, and more",
      "group": "Extensions",
      "report": "contracts",
      "actions": [
        {
          "id": "contracts",
          "label": "See the hook points and your hooks",
          "word": "contracts",
          "line": "/hooks contracts [<only those about...>]",
          "sentence": "Shows each hook point {filter}, what a hook there may do, and the managed hooks file.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "filter",
              "label": "Only those about",
              "help": "Words to narrow the list",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "all of them"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "open",
          "label": "Open the hooks screen",
          "word": "open",
          "line": "/hooks open",
          "sentence": "Opens the full-screen view of hook points and managed hooks.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "scaffold",
          "label": "Make a hook",
          "word": "scaffold",
          "line": "/hooks scaffold <name> <when it runs> [--type <what it does>]",
          "sentence": "A managed hook {name} of kind {type} that runs at {match} is added to the hooks file, switched on, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "remove",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A short name you choose",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "match",
              "label": "When it runs",
              "help": "The hook point it runs at, as /hooks contracts shows it (Pre:tool:exec)",
              "kind": "text",
              "freeTextReason": "a hook point pattern from /hooks contracts",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "type",
              "label": "What it does",
              "help": "What the hook runs",
              "kind": "choice",
              "choices": [
                {
                  "value": "command",
                  "label": "Run a command"
                },
                {
                  "value": "prompt",
                  "label": "Ask the model"
                },
                {
                  "value": "agent",
                  "label": "Start an agent"
                },
                {
                  "value": "http",
                  "label": "Call a web address"
                },
                {
                  "value": "ts",
                  "label": "Run a TypeScript file"
                }
              ],
              "required": true,
              "typed": {
                "flag": "--type"
              }
            }
          ]
        },
        {
          "id": "chain",
          "label": "Make a chain of hook points",
          "word": "chain",
          "line": "/hooks chain <name> <hook points in order>",
          "sentence": "A managed chain {name} over {events} is added to the hooks file until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "remove",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A short name you choose",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "events",
              "label": "Hook points in order",
              "help": "Hook points, separated by commas",
              "kind": "text",
              "freeTextReason": "hook point patterns from /hooks contracts",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "enable",
          "label": "Switch a hook on",
          "word": "enable",
          "line": "/hooks enable <hook>",
          "sentence": "{hook} runs at its hook point again, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "disable",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": [
            {
              "id": "hook",
              "label": "Hook",
              "help": "The managed hooks and chains",
              "kind": "choice",
              "choices": {
                "list": "hooks.managed"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "disable",
          "label": "Switch a hook off",
          "word": "disable",
          "line": "/hooks disable <hook>",
          "sentence": "{hook} stops running at its hook point, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "enable",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": [
            {
              "id": "hook",
              "label": "Hook",
              "help": "The managed hooks and chains",
              "kind": "choice",
              "choices": {
                "list": "hooks.managed"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "remove",
          "label": "Remove a hook or chain",
          "word": "remove",
          "line": "/hooks remove <hook>",
          "sentence": "The managed hook or chain {hook} is deleted from the hooks file; export first with /hooks export to keep a copy.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": [
            {
              "id": "hook",
              "label": "Hook",
              "help": "The managed hooks and chains",
              "kind": "choice",
              "choices": {
                "list": "hooks.managed"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "simulate",
          "label": "See which hooks an event would run",
          "word": "simulate",
          "line": "/hooks simulate <event>",
          "sentence": "Shows the hooks and chains that {event} would run; nothing runs.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "event",
              "label": "Event",
              "help": "An event path, such as Pre:tool:exec",
              "kind": "text",
              "freeTextReason": "an event path",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "reload",
          "label": "Read the hooks file again",
          "word": "reload",
          "line": "/hooks reload",
          "sentence": "The managed hooks file is read again, so edits made by hand take effect now.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": []
        },
        {
          "id": "export",
          "label": "Save the hooks to a file",
          "word": "export",
          "line": "/hooks export [<file>]",
          "sentence": "Every managed hook and chain is written to {path} as a bundle.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "Where to write the bundle",
              "kind": "path",
              "freeTextReason": "a file path on this machine",
              "required": {
                "default": "",
                "defaultMeans": "the hooks file itself"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "inspect",
          "label": "Look inside a hooks bundle",
          "word": "inspect",
          "line": "/hooks inspect <file>",
          "sentence": "Shows how many hooks and chains {path} holds and their hook points; nothing is installed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A hooks bundle file",
              "kind": "path",
              "freeTextReason": "a file path on this machine",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "import",
          "label": "Install hooks from a bundle",
          "word": "import",
          "line": "/hooks import <file> [--strategy <your hooks now>]",
          "sentence": "The hooks and chains in {path} are installed, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Managed hooks are kept in this machine's hooks file."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A hooks bundle file",
              "kind": "path",
              "freeTextReason": "a file path on this machine",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "strategy",
              "label": "Your hooks now",
              "help": "Keep the hooks installed now, or replace them all",
              "kind": "choice",
              "choices": [
                {
                  "value": "merge",
                  "label": "Keep them and add the bundle's"
                },
                {
                  "value": "replace",
                  "label": "Replace them all with the bundle's",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "merge",
                "defaultMeans": "keep them"
              },
              "typed": {
                "flag": "--strategy"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "hosted",
      "title": "Hosted sessions",
      "summary": "Conversations that run in the daemon, so they go on when this window closes",
      "group": "Sessions",
      "report": "see-joined",
      "actions": [
        {
          "id": "see-joined",
          "label": "See the hosted session you are in",
          "word": "status",
          "line": "/hosted status",
          "sentence": "Shows the hosted session this terminal joined, what leaving it would do, and the tool running in it.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is the session this terminal joined."
          },
          "inputs": []
        },
        {
          "id": "start",
          "label": "Start a hosted session",
          "word": "new",
          "line": "/hosted new [--on-leave <when everyone leaves>] [<first message...>]",
          "sentence": "A conversation will start in the daemon for this project and this terminal joins it; it lasts until you change it (ending it, or as \"When everyone leaves\" says).",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "end",
          "operator": {
            "method": "sessions.hosted.create",
            "fields": {
              "initialPrompt": "prompt"
            }
          },
          "inputs": [
            {
              "id": "prompt",
              "label": "First message",
              "help": "What it should start on, the way you would ask in the chat",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "nothing yet"
              },
              "typed": {
                "tail": true
              }
            },
            {
              "id": "leave",
              "label": "When everyone leaves",
              "help": "Whether it keeps running once no terminal or browser has it open",
              "kind": "choice",
              "choices": [
                {
                  "value": "keep",
                  "label": "Keep running",
                  "help": "It waits, idle, to be joined again."
                },
                {
                  "value": "stop",
                  "label": "Stop it",
                  "help": "It ends when the last one leaves."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "as hostedSessions.detachPolicy says"
              },
              "typed": {
                "flag": "--on-leave"
              }
            }
          ]
        },
        {
          "id": "see-all",
          "label": "See hosted sessions",
          "word": "list",
          "line": "/hosted list [--all]",
          "sentence": "Lists the hosted sessions the daemon has, who has joined each, and what leaving would do.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.hosted.list",
            "fields": {}
          },
          "inputs": [
            {
              "id": "ended",
              "label": "Ended ones too",
              "help": "Also the ones that have ended and are still kept",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "Only running ones"
                },
                {
                  "value": "yes",
                  "label": "Ended ones too"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "only running ones"
              },
              "typed": {
                "flag": "--all",
                "switchOn": "yes"
              }
            }
          ]
        },
        {
          "id": "join",
          "label": "Join a hosted session",
          "word": "attach",
          "line": "/hosted attach <session>",
          "sentence": "This terminal joins hosted session {session}, shows its conversation so far and follows it live.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.hosted.attach",
            "fields": {
              "sessionId": "session"
            }
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "The hosted sessions the daemon has",
              "kind": "choice",
              "choices": {
                "list": "hosted.sessions",
                "allowOther": {
                  "reason": "a session id, or its number in the last /hosted list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "send-now",
          "label": "Send a message now",
          "word": "send",
          "line": "/hosted send <message...>",
          "sentence": "\"{text}\" will be sent to the hosted session now, into the turn it is running.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.steer",
            "fields": {
              "message": "text"
            }
          },
          "inputs": [
            {
              "id": "text",
              "label": "Message",
              "help": "What to tell it; it reads it during the turn it is in",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "send-later",
          "label": "Send a message after this turn",
          "word": "send-later",
          "line": "/hosted send-later <message...>",
          "sentence": "\"{text}\" will wait and run after the hosted session's current turn.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.followUp",
            "fields": {
              "message": "text"
            }
          },
          "inputs": [
            {
              "id": "text",
              "label": "Message",
              "help": "What it should do next, once the turn it is in ends",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "stop-tool",
          "label": "Stop the tool that is running",
          "word": "stop-tool",
          "line": "/hosted stop-tool [<tool>]",
          "sentence": "The tool call {call} in the hosted session will be stopped; the turn goes on without its result.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.toolCalls.cancel",
            "fields": {
              "callId": "call"
            }
          },
          "inputs": [
            {
              "id": "call",
              "label": "Tool",
              "help": "The tools running in the session now",
              "kind": "choice",
              "choices": {
                "list": "hosted.running-tools",
                "allowOther": {
                  "reason": "a tool call id"
                }
              },
              "required": {
                "default": "",
                "defaultMeans": "the one running now"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "leave",
          "label": "Leave the hosted session",
          "word": "leave",
          "line": "/hosted leave",
          "sentence": "This terminal leaves the hosted session; it keeps running or ends, as its \"when everyone leaves\" setting says.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "undoneBy": "join",
          "operator": {
            "method": "sessions.hosted.detach",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "end",
          "label": "End a hosted session",
          "word": "end",
          "line": "/hosted end <session>",
          "sentence": "Hosted session {session} and the turn it is running will end, whatever its setting says.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "sessions.hosted.kill",
            "fields": {
              "sessionId": "session"
            }
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "The hosted sessions the daemon has",
              "kind": "choice",
              "choices": {
                "list": "hosted.sessions",
                "allowOther": {
                  "reason": "a session id"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "local-auth",
      "title": "Local sign-in",
      "summary": "Choose who may sign in to this machine's daemon and web app",
      "group": "Setup",
      "report": "see-users",
      "actions": [
        {
          "id": "see-users",
          "label": "See who may sign in",
          "word": "review",
          "line": "/local-auth review",
          "sentence": "Shows the local users, their roles, the open sessions and whether the first-run sign-in file is still there.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "local_auth.status",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "open-screen",
          "label": "Open the local sign-in screen",
          "word": "open",
          "line": "/local-auth open",
          "sentence": "Opens the full-screen view of local users and sessions.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "add-user",
          "label": "Let someone sign in",
          "word": "add",
          "line": "/local-auth add <user name> [--password <password>] [--again <password again>] [--role <role>]",
          "sentence": "{user} will be able to sign in to this machine's daemon and web app as a {role}, until you change it.",
          "done": "{user} may sign in as a {role}.",
          "touches": "credential",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "remove-user",
          "operator": {
            "method": "local_auth.users.create",
            "fields": {
              "username": "user",
              "password": "password",
              "roles": "role"
            }
          },
          "inputs": [
            {
              "id": "user",
              "label": "User name",
              "help": "The name they sign in with",
              "kind": "text",
              "freeTextReason": "a name you choose for them",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "password",
              "label": "Password",
              "help": "Hidden as you type",
              "kind": "secret",
              "required": true,
              "typed": {
                "flag": "--password"
              }
            },
            {
              "id": "again",
              "label": "Password again",
              "help": "The same password, to catch a typing mistake",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "not typed a second time"
              },
              "typed": {
                "flag": "--again"
              }
            },
            {
              "id": "role",
              "label": "Role",
              "help": "What they may do once signed in",
              "kind": "choice",
              "choices": [
                {
                  "value": "user",
                  "label": "User",
                  "help": "Can sign in and use the web app."
                },
                {
                  "value": "admin",
                  "label": "Administrator",
                  "help": "Can also manage users, settings and the daemon.",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": {
                "default": "user",
                "defaultMeans": "a user, not an administrator"
              },
              "typed": {
                "flag": "--role"
              }
            }
          ]
        },
        {
          "id": "remove-user",
          "label": "Stop someone signing in",
          "word": "remove",
          "line": "/local-auth remove <user>",
          "sentence": "{user} will no longer be able to sign in, and the account is deleted; add it again to let them back in.",
          "done": "Removed {user}.",
          "touches": "credential",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "local_auth.users.delete",
            "fields": {
              "username": "user"
            }
          },
          "inputs": [
            {
              "id": "user",
              "label": "User",
              "help": "The people who may sign in here",
              "kind": "choice",
              "choices": {
                "list": "local-auth.users"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "change-password",
          "label": "Change someone's password",
          "word": "password",
          "line": "/local-auth password <user> [--password <password>] [--again <password again>]",
          "sentence": "{user}'s password will be replaced and everyone signed in as {user} is signed out, until you change it.",
          "done": "Changed {user}'s password; their open sessions were ended.",
          "touches": "credential",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "local_auth.users.password.rotate",
            "fields": {
              "username": "user",
              "password": "password"
            }
          },
          "inputs": [
            {
              "id": "user",
              "label": "User",
              "help": "The people who may sign in here",
              "kind": "choice",
              "choices": {
                "list": "local-auth.users"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "password",
              "label": "Password",
              "help": "Hidden as you type",
              "kind": "secret",
              "required": true,
              "typed": {
                "flag": "--password"
              }
            },
            {
              "id": "again",
              "label": "Password again",
              "help": "The same password, to catch a typing mistake",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "not typed a second time"
              },
              "typed": {
                "flag": "--again"
              }
            }
          ]
        },
        {
          "id": "end-session",
          "label": "Sign someone out",
          "word": "sign-out",
          "line": "/local-auth sign-out <session>",
          "sentence": "Session {session} will be ended; whoever uses it must sign in again.",
          "done": "Ended session {session}.",
          "touches": "credential",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "local_auth.sessions.delete",
            "fields": {
              "sessionId": "session"
            }
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "Who is signed in now",
              "kind": "choice",
              "choices": {
                "list": "local-auth.sessions"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "remove-first-run-file",
          "label": "Remove the first-run sign-in file",
          "word": "remove-first-run-file",
          "line": "/local-auth remove-first-run-file",
          "sentence": "The file holding the first-run sign-in is deleted; if no user has been added, nobody can sign in to the web app until one is.",
          "done": "",
          "touches": "credential",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "local_auth.bootstrap.delete",
            "fields": {}
          },
          "inputs": []
        }
      ]
    },
    {
      "name": "managed",
      "title": "Managed settings",
      "summary": "Apply settings bundles your organisation manages, lock settings, and roll an apply back",
      "group": "Settings",
      "report": "review",
      "actions": [
        {
          "id": "review",
          "label": "See managed settings at a glance",
          "word": "review",
          "line": "/managed review",
          "sentence": "Shows saved profiles, the staged bundle, active locks and rollback records.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "staged",
          "label": "See the staged bundle",
          "word": "staged",
          "line": "/managed staged",
          "sentence": "Shows the bundle staged to apply, its stage id and each change it makes.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "history",
          "label": "See applies you can roll back",
          "word": "history",
          "line": "/managed history",
          "sentence": "Shows each managed apply with its rollback token and how many settings it changed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "inspect",
          "label": "Look inside a managed bundle",
          "word": "inspect",
          "line": "/managed inspect <bundle file>",
          "sentence": "Shows what {path} would change here and how risky it is; nothing is changed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "A managed settings bundle (JSON)",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "export",
          "label": "Save a profile as a managed bundle",
          "word": "export",
          "line": "/managed export <profile> <bundle file>",
          "sentence": "The settings of profile {profile} are written to {path} as a managed bundle.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Managed settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "profile",
              "label": "Profile",
              "help": "Your saved settings profiles",
              "kind": "choice",
              "choices": {
                "list": "managed.profiles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "path",
              "label": "Bundle file",
              "help": "Where to write the bundle",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "stage",
          "label": "Stage a managed bundle to apply later",
          "word": "stage",
          "line": "/managed stage <bundle file>",
          "sentence": "The changes in {path} are staged, ready to apply, until you change it; nothing is applied yet.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Managed settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "A managed settings bundle (JSON)",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "apply",
          "label": "Apply a managed bundle",
          "word": "apply",
          "line": "/managed apply <bundle file> [--key <only these settings>]...",
          "sentence": "The settings in {path} are applied and locked as managed until you change it (or roll it back); changes that touch security are shown and asked about first.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "rollback",
          "operator": {
            "terminalOnly": "Managed settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "A managed settings bundle (JSON)",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "keys",
              "label": "Only these settings",
              "help": "Setting keys, separated by commas",
              "kind": "text",
              "freeTextReason": "setting keys from /settings",
              "required": {
                "default": "",
                "defaultMeans": "every setting in it"
              },
              "typed": {
                "flag": "--key",
                "repeats": true
              }
            }
          ]
        },
        {
          "id": "apply-staged",
          "label": "Apply the staged bundle",
          "word": "apply-staged",
          "line": "/managed apply-staged [--key <only these settings>]...",
          "sentence": "The staged settings are applied and locked as managed until you change it (or roll it back); changes that touch security are shown and asked about first.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "rollback",
          "operator": {
            "terminalOnly": "Managed settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "keys",
              "label": "Only these settings",
              "help": "Setting keys, separated by commas",
              "kind": "text",
              "freeTextReason": "setting keys from /settings",
              "required": {
                "default": "",
                "defaultMeans": "every setting in it"
              },
              "typed": {
                "flag": "--key",
                "repeats": true
              }
            }
          ]
        },
        {
          "id": "rollback",
          "label": "Put back the values from before an apply",
          "word": "rollback",
          "line": "/managed rollback <apply>",
          "sentence": "The settings apply {token} changed get their earlier values back, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Managed settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "token",
              "label": "Apply",
              "help": "Past managed applies",
              "kind": "choice",
              "choices": {
                "list": "managed.rollbacks"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "lock",
          "label": "Lock a setting as managed",
          "word": "lock",
          "line": "/managed lock <setting> <who manages it> <why...>",
          "sentence": "{key} is locked as managed by {source} (\"{reason}\"), so it cannot be changed here, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "unlock",
          "operator": {
            "terminalOnly": "Managed settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Setting",
              "help": "A setting key, as /settings shows it",
              "kind": "text",
              "freeTextReason": "a setting key from /settings",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "source",
              "label": "Who manages it",
              "help": "Who set the lock (your team, an admin)",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "The reason shown to whoever tries to change it",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "unlock",
          "label": "Unlock a managed setting",
          "word": "unlock",
          "line": "/managed unlock <setting>",
          "sentence": "The managed lock on {key} is cleared, so it can be changed here again, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "a lock set by your organisation is a security setting",
            "instead": "Ask the owner to unlock it with /managed unlock."
          },
          "undoneBy": "lock",
          "operator": {
            "terminalOnly": "Managed settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Setting",
              "help": "A setting key, as /settings shows it",
              "kind": "text",
              "freeTextReason": "a setting key from /settings",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "marketplace",
      "title": "Marketplace",
      "summary": "Find, install and update curated plugins, skills, hook packs and policy packs",
      "group": "Extensions",
      "report": "overview",
      "actions": [
        {
          "id": "overview",
          "label": "See the marketplace at a glance",
          "word": "overview",
          "line": "/marketplace overview",
          "sentence": "Shows how many curated entries of each kind there are and how many are installed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "open",
          "label": "Open the marketplace screen",
          "word": "open",
          "line": "/marketplace open",
          "sentence": "Opens the full-screen marketplace to browse and install from.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "browse",
          "label": "Browse the catalog",
          "word": "browse",
          "line": "/marketplace browse [<looking for...>]",
          "sentence": "Lists curated entries of every kind that match {query}.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "query",
              "label": "Looking for",
              "help": "Words to search for",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "everything"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "recommend",
          "label": "See what fits this project",
          "word": "recommend",
          "line": "/marketplace recommend",
          "sentence": "Shows curated entries that fit this project, ranked when a decision model is set.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "installed",
          "label": "See what is installed",
          "word": "installed",
          "line": "/marketplace installed",
          "sentence": "Lists every curated entry installed, where, and for which projects.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "review",
          "label": "Check an entry before installing",
          "word": "review",
          "line": "/marketplace review <kind> <entry>",
          "sentence": "Shows the {kind} {entry}'s source, risk, compatibility and the scope it suits.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Curated entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.catalog",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "provenance",
          "label": "See where an entry comes from",
          "word": "provenance",
          "line": "/marketplace provenance <kind> <entry>",
          "sentence": "Shows the {kind} {entry}'s source, author, version, signature and trust notes.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Curated entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.catalog",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "install-hint",
          "label": "See how an entry is installed",
          "word": "install-hint",
          "line": "/marketplace install-hint <kind> <entry>",
          "sentence": "Shows the {kind} {entry}'s install guidance and trust notes.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Curated entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.catalog",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "install",
          "label": "Install an entry",
          "word": "install",
          "line": "/marketplace install <kind> <entry> [--scope <install for>]",
          "sentence": "The {kind} {entry} is installed for {scope} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "uninstall",
          "operator": {
            "terminalOnly": "The catalog and what is installed are on this machine."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Curated entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.catalog",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "update",
          "label": "Update an installed entry",
          "word": "update",
          "line": "/marketplace update <kind> <entry> [--scope <install for>]",
          "sentence": "The installed {kind} {entry} ({scope}) is updated to the catalog's version until you change it; the old one is kept as a backup.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "rollback",
          "operator": {
            "terminalOnly": "The catalog and what is installed are on this machine."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Installed entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.installed",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "history",
          "label": "See an entry's backups",
          "word": "history",
          "line": "/marketplace history <kind> <entry> [--scope <install for>]",
          "sentence": "Lists the backups the {kind} {entry} can be rolled back to.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Installed entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.installed",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "rollback",
          "label": "Roll an entry back to a backup",
          "word": "rollback",
          "line": "/marketplace rollback <kind> <entry> [--scope <install for>] [--backup <backup>]",
          "sentence": "The installed {kind} {entry} ({scope}) goes back to an earlier backup until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "update",
          "operator": {
            "terminalOnly": "The catalog and what is installed are on this machine."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Installed entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.installed",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "backup",
              "label": "Backup",
              "help": "Its backups, newest first",
              "kind": "choice",
              "choices": {
                "list": "marketplace.backups",
                "dependsOn": "entry"
              },
              "required": {
                "default": "",
                "defaultMeans": "the newest one"
              },
              "typed": {
                "flag": "--backup"
              }
            }
          ]
        },
        {
          "id": "receipt",
          "label": "See an entry's install receipt",
          "word": "receipt",
          "line": "/marketplace receipt <kind> <entry> [--scope <install for>]",
          "sentence": "Shows when and where the {kind} {entry} was installed, and its provenance and compatibility.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Installed entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.installed",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "uninstall",
          "label": "Uninstall an entry",
          "word": "uninstall",
          "line": "/marketplace uninstall <kind> <entry> [--scope <install for>]",
          "sentence": "The installed {kind} {entry} ({scope}) is removed from disk with its install receipt; /marketplace install installs it again from the catalog.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The catalog and what is installed are on this machine."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "plugin",
                  "label": "Plugin"
                },
                {
                  "value": "skill",
                  "label": "Skill"
                },
                {
                  "value": "hook-pack",
                  "label": "Hook pack"
                },
                {
                  "value": "policy-pack",
                  "label": "Policy pack"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "entry",
              "label": "Entry",
              "help": "Installed entries of this kind",
              "kind": "choice",
              "choices": {
                "list": "marketplace.installed",
                "dependsOn": "kind"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "bundle-export",
          "label": "Save your installs to a bundle",
          "word": "bundle-export",
          "line": "/marketplace bundle-export <bundle file> [--scope <install for>]",
          "sentence": "What is installed for {scope} is written to {path} as a bundle another machine can bring in.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The catalog and what is installed are on this machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "Where to write the bundle",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "bundle-inspect",
          "label": "Look inside a marketplace bundle",
          "word": "bundle-inspect",
          "line": "/marketplace bundle-inspect <bundle file>",
          "sentence": "Shows what {path} holds; nothing is installed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "A marketplace bundle (JSON)",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "bundle-import",
          "label": "Bring in installs from a bundle",
          "word": "bundle-import",
          "line": "/marketplace bundle-import <bundle file> [--scope <install for>]",
          "sentence": "The entries in {path} are merged into what is installed for {scope}, by kind and id, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The catalog and what is installed are on this machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "A marketplace bundle (JSON)",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "scope",
              "label": "Install for",
              "help": "This project, or all your projects",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project"
                },
                {
                  "value": "user",
                  "label": "All your projects"
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "mcp",
      "title": "MCP servers and tools",
      "summary": "Connect tools from other programs",
      "group": "Tools",
      "report": "see-servers",
      "actions": [
        {
          "id": "see-servers",
          "label": "See your servers",
          "word": "servers",
          "line": "/mcp servers",
          "sentence": "Shows every MCP server, whether it is connected, its trust level, role and tool rules.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "mcp.servers.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "see-tools",
          "label": "See a server's tools",
          "word": "tools",
          "line": "/mcp tools [<server>]",
          "sentence": "Lists the tools {server} offers right now.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "mcp.tools.list",
            "fields": {}
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": {
                "default": "",
                "defaultMeans": "every server"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "block-tool",
          "label": "Block a tool",
          "word": "block",
          "line": "/mcp block <server> <tool> [--keep]",
          "sentence": "Every call to {tool} on {server} will be refused {lasts}.",
          "done": "Blocked {tool} on {server} {lasts}.",
          "touches": "this-machine",
          "lasts": {
            "byInput": "lasts"
          },
          "risk": "none",
          "undoneBy": "unblock-tool",
          "operator": {
            "method": "mcp.servers.tools.block",
            "fields": {
              "serverName": "server",
              "toolName": "tool"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "tool",
              "label": "Tool",
              "help": "Tools this server offers right now",
              "kind": "choice",
              "choices": {
                "list": "mcp.tools",
                "dependsOn": "server",
                "allowOther": {
                  "reason": "a tool the server has not listed (it is not connected now)"
                }
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "lasts",
              "label": "How long",
              "help": "For this session, or kept with the server's settings",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session only",
                  "help": "Ends when you close this app.",
                  "lasts": "session"
                },
                {
                  "value": "kept",
                  "label": "Until I unblock it",
                  "help": "Kept with the server's entry in its MCP config, after a restart too.",
                  "lasts": "kept"
                }
              ],
              "required": {
                "default": "session",
                "defaultMeans": "this session only"
              },
              "typed": {
                "flag": "--keep",
                "switchOn": "kept"
              }
            }
          ]
        },
        {
          "id": "unblock-tool",
          "label": "Stop blocking a tool",
          "word": "unblock",
          "line": "/mcp unblock <server> <tool>",
          "sentence": "{tool} on {server} will be callable again, under {server}'s usual trust and limits, until you change it.",
          "done": "Stopped blocking {tool} on {server}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "it loosens what an MCP server may do",
            "instead": "Ask the owner to unblock it from /mcp or Settings."
          },
          "undoneBy": "block-tool",
          "operator": {
            "method": "mcp.servers.tools.unblock",
            "fields": {
              "serverName": "server",
              "toolName": "tool"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "tool",
              "label": "Tool",
              "help": "Tools blocked on this server",
              "kind": "choice",
              "choices": {
                "list": "mcp.tools.blocked",
                "dependsOn": "server"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "exempt-tool",
          "label": "Let a tool go beyond its server's limits",
          "word": "exempt",
          "line": "/mcp exempt <server> <tool>",
          "sentence": "Calls to {tool} on {server} will pass {server}'s folder and site limits until you change it. A block of {tool}, a held-back server or a server set to refuse every call still refuses it.",
          "done": "{tool} on {server} now goes past {server}'s limits, until you change it.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "it loosens what an MCP server may do",
            "instead": "Ask the owner; it is kept in the global MCP config."
          },
          "undoneBy": "unexempt-tool",
          "operator": {
            "method": "mcp.servers.tools.exempt",
            "fields": {
              "serverName": "server",
              "toolName": "tool"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "tool",
              "label": "Tool",
              "help": "Tools this server offers right now",
              "kind": "choice",
              "choices": {
                "list": "mcp.tools",
                "dependsOn": "server",
                "allowOther": {
                  "reason": "a tool the server has not listed (it is not connected now)"
                }
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "unexempt-tool",
          "label": "Make a tool follow its server's limits again",
          "word": "unexempt",
          "line": "/mcp unexempt <server> <tool>",
          "sentence": "Calls to {tool} on {server} will be held to {server}'s folder and site limits again, until you change it.",
          "done": "{tool} on {server} follows {server}'s limits again.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "exempt-tool",
          "operator": {
            "method": "mcp.servers.tools.unexempt",
            "fields": {
              "serverName": "server",
              "toolName": "tool"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "tool",
              "label": "Tool",
              "help": "Tools that go past this server's limits",
              "kind": "choice",
              "choices": {
                "list": "mcp.tools.exempt",
                "dependsOn": "server"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "add-server",
          "label": "Add a server",
          "word": "add",
          "line": "/mcp add <name> [--url <address>] [--trust <trust>] [--role <role>] [--scope <kept for>] [--path <folders it may use>]... [--host <sites it may reach>]... [--env <environment>]... [--header <request header>]... [-- <command>...]",
          "sentence": "{name} will be added to the {scope} MCP config and started now, until you change it.",
          "done": "Added {name}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "remove-server",
          "operator": {
            "method": "mcp.servers.upsert",
            "fields": {
              "scope": "scope",
              "server.name": "name",
              "server.command": "command:first",
              "server.args": "command:rest",
              "server.url": "address",
              "server.trustMode": "trust",
              "server.role": "role",
              "server.allowedPaths": "path:lines",
              "server.allowedHosts": "host:lines",
              "server.env": "env:pairs",
              "server.headers": "header:pairs"
            }
          },
          "inputs": [
            {
              "id": "start",
              "label": "How it starts",
              "help": "How do you start it?",
              "kind": "choice",
              "choices": [
                {
                  "value": "command",
                  "label": "A command on this computer"
                },
                {
                  "value": "url",
                  "label": "A web address"
                }
              ],
              "required": {
                "default": "command",
                "defaultMeans": "a command on this computer"
              },
              "typed": {
                "impliedBy": {
                  "input": "address",
                  "ifGiven": "url",
                  "ifNot": "command"
                }
              }
            },
            {
              "id": "command",
              "label": "Command",
              "help": "The program to start and its own arguments, as you would type them",
              "kind": "list",
              "freeTextReason": "the program and its arguments",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "address",
              "label": "Address",
              "help": "The https:// address the server answers at",
              "kind": "text",
              "freeTextReason": "the address the server answers at",
              "required": true,
              "typed": {
                "flag": "--url"
              }
            },
            {
              "id": "name",
              "label": "Name",
              "help": "A short name you choose for it",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "trust",
              "label": "Trust",
              "help": "What it may do without asking",
              "kind": "choice",
              "choices": [
                {
                  "value": "constrained",
                  "label": "Ask before anything outside its limits",
                  "help": "Calls inside its folders and sites run; anything else is put to you."
                },
                {
                  "value": "ask-on-risk",
                  "label": "Act inside its limits without asking",
                  "help": "Calls inside its scope run without asking; a call outside is put to you.",
                  "risk": "loosens-a-protection"
                },
                {
                  "value": "blocked",
                  "label": "Refuse every call",
                  "help": "No tool of the server runs."
                },
                {
                  "value": "allow-all",
                  "label": "Allow every call",
                  "help": "Every call runs, inside its limits or not.",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "ask before anything outside its limits"
              },
              "typed": {
                "flag": "--trust"
              }
            },
            {
              "id": "role",
              "label": "Role",
              "help": "What kind of server it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "general",
                  "label": "General"
                },
                {
                  "value": "docs",
                  "label": "Documentation"
                },
                {
                  "value": "filesystem",
                  "label": "Files"
                },
                {
                  "value": "git",
                  "label": "Git"
                },
                {
                  "value": "database",
                  "label": "Database"
                },
                {
                  "value": "browser",
                  "label": "Browser"
                },
                {
                  "value": "automation",
                  "label": "Automation"
                },
                {
                  "value": "ops",
                  "label": "Operations"
                },
                {
                  "value": "remote",
                  "label": "Remote machines"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "general"
              },
              "typed": {
                "flag": "--role"
              }
            },
            {
              "id": "scope",
              "label": "Kept for",
              "help": "Which MCP config file keeps it",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Kept in this project's .goodvibes/mcp.json."
                },
                {
                  "value": "global",
                  "label": "All your projects",
                  "help": "Kept in ~/.config/mcp/mcp.json."
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project only"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "path",
              "label": "Folders it may use",
              "help": "Folders, separated by commas",
              "kind": "path",
              "freeTextReason": "a folder on this machine",
              "required": {
                "default": "",
                "defaultMeans": "none besides the project"
              },
              "typed": {
                "flag": "--path",
                "repeats": true
              }
            },
            {
              "id": "host",
              "label": "Sites it may reach",
              "help": "Host names, separated by commas",
              "kind": "text",
              "freeTextReason": "a host name such as api.github.com",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--host",
                "repeats": true
              }
            },
            {
              "id": "env",
              "label": "Environment",
              "help": "NAME=VALUE for a command, separated by commas; hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--env",
                "repeats": true
              }
            },
            {
              "id": "header",
              "label": "Request header",
              "help": "Name=Value for a web address (an Authorization header); hidden as you type",
              "kind": "secret",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--header",
                "repeats": true
              }
            }
          ]
        },
        {
          "id": "remove-server",
          "label": "Remove a server",
          "word": "remove",
          "line": "/mcp remove <server> [--scope <from>]",
          "sentence": "{server}'s entry (its command, arguments, environment and trust) will be deleted from the {scope} MCP config and its tools stop being offered.",
          "done": "Removed {server}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "mcp.servers.remove",
            "fields": {
              "serverName": "server",
              "scope": "scope"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "scope",
              "label": "From",
              "help": "Which MCP config file to remove it from",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Kept in this project's .goodvibes/mcp.json."
                },
                {
                  "value": "global",
                  "label": "All your projects",
                  "help": "Kept in ~/.config/mcp/mcp.json."
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project only"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "reload",
          "label": "Reconnect every server from its config",
          "word": "reload",
          "line": "/mcp reload",
          "sentence": "Every MCP server is read again from its config file and reconnected.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "mcp.servers.reload",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "set-trust",
          "label": "Set a server's trust level",
          "word": "trust",
          "line": "/mcp trust <server> <trust>",
          "sentence": "{server} will be set to \"{mode}\" until you change it.",
          "done": "{server} is set to \"{mode}\".",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "restore-trust",
          "operator": {
            "method": "mcp.servers.trust.set",
            "fields": {
              "serverName": "server",
              "trustMode": "mode"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "mode",
              "label": "Trust",
              "help": "What it may do without asking",
              "kind": "choice",
              "choices": [
                {
                  "value": "constrained",
                  "label": "Ask before anything outside its limits",
                  "help": "Calls inside its folders and sites run; anything else is put to you."
                },
                {
                  "value": "ask-on-risk",
                  "label": "Act inside its limits without asking",
                  "help": "Calls inside its scope run without asking; a call outside is put to you.",
                  "risk": "loosens-a-protection"
                },
                {
                  "value": "blocked",
                  "label": "Refuse every call",
                  "help": "No tool of the server runs."
                },
                {
                  "value": "allow-all",
                  "label": "Allow every call",
                  "help": "Every call runs, inside its limits or not.",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "restore-trust",
          "label": "Go back to the saved trust level",
          "word": "restore-trust",
          "line": "/mcp restore-trust <server>",
          "sentence": "{server} goes back to the trust level saved in its MCP config, which may allow more than the level set for this session, until you change it.",
          "done": "{server} is back on its saved trust level.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "the saved level may allow more than the one set for this session",
            "instead": "Ask the owner to choose \"Go back to the saved trust level\" in /mcp."
          },
          "operator": {
            "terminalOnly": "A trust level set for this session belongs to that terminal app's session."
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "set-role",
          "label": "Set a server's role",
          "word": "role",
          "line": "/mcp role <server> <role>",
          "sentence": "{server} will be treated as a {role} server until you change it.",
          "done": "{server} is a {role} server.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "restore-role",
          "operator": {
            "method": "mcp.servers.role.set",
            "fields": {
              "serverName": "server",
              "role": "role"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "role",
              "label": "Role",
              "help": "What kind of server it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "general",
                  "label": "General"
                },
                {
                  "value": "docs",
                  "label": "Documentation"
                },
                {
                  "value": "filesystem",
                  "label": "Files"
                },
                {
                  "value": "git",
                  "label": "Git"
                },
                {
                  "value": "database",
                  "label": "Database"
                },
                {
                  "value": "browser",
                  "label": "Browser"
                },
                {
                  "value": "automation",
                  "label": "Automation"
                },
                {
                  "value": "ops",
                  "label": "Operations"
                },
                {
                  "value": "remote",
                  "label": "Remote machines"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "restore-role",
          "label": "Go back to the saved role",
          "word": "restore-role",
          "line": "/mcp restore-role <server>",
          "sentence": "{server} goes back to the role saved in its MCP config, until you change it.",
          "done": "{server} is back on its saved role.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "A role set for this session belongs to that terminal app's session."
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "hold-back",
          "label": "Hold back a server's tools for review",
          "word": "quarantine",
          "line": "/mcp quarantine <server> [<why...>]",
          "sentence": "{server}'s tools will not be offered {lasts}, until you accept them again.",
          "done": "Held back {server}'s tools.",
          "touches": "this-machine",
          "lasts": "session",
          "risk": "none",
          "undoneBy": "accept-tools",
          "operator": {
            "terminalOnly": "Holding back tools applies to the terminal app's own MCP connections."
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "A note you will see when you review it",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "held back by you",
                "defaultMeans": "no note"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "accept-tools",
          "label": "Accept a server's changed tools",
          "word": "accept-tools",
          "line": "/mcp accept-tools <server>",
          "sentence": "{server}'s changed tools will be accepted and offered again {lasts}.",
          "done": "Accepted {server}'s tools.",
          "touches": "this-machine",
          "lasts": "session",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "it offers tools that changed since they were last accepted",
            "instead": "Ask the owner to accept them from /mcp."
          },
          "undoneBy": "hold-back",
          "operator": {
            "method": "mcp.servers.quarantine.accept",
            "fields": {
              "serverName": "server"
            }
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "Servers whose tools are held back",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers.held-back"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "review",
          "label": "See which servers need attention",
          "word": "review",
          "line": "/mcp review",
          "sentence": "Shows the servers that are not connected or whose tools are held back, with what to do next.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "mcp.servers.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "repair",
          "label": "See how to fix a server",
          "word": "repair",
          "line": "/mcp repair [<server>]",
          "sentence": "Shows {server}'s state and the steps that fix it.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The steps name terminal commands."
          },
          "inputs": [
            {
              "id": "server",
              "label": "Server",
              "help": "The MCP servers you have",
              "kind": "choice",
              "choices": {
                "list": "mcp.servers"
              },
              "required": {
                "default": "",
                "defaultMeans": "the first one that needs attention"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "see-config-files",
          "label": "See where servers are configured",
          "word": "files",
          "line": "/mcp files",
          "sentence": "Shows each MCP config file in use, whether it can be written, and which servers come from it.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "mcp.config.get",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "open-screen",
          "label": "Open the MCP screen",
          "word": "open",
          "line": "/mcp open",
          "sentence": "Opens the full-screen view of servers, tools and config files.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        }
      ]
    },
    {
      "name": "memory",
      "title": "Memory",
      "summary": "What the project remembers: decisions, constraints, incidents and patterns, with where each came from",
      "group": "Knowledge",
      "report": "see-memory",
      "actions": [
        {
          "id": "see-memory",
          "label": "See your memory",
          "word": "list",
          "line": "/memory list [--class <kind>] [--scope <where it applies>]",
          "sentence": "Lists memory records by kind, newest first, with where each applies.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "memory.records.list",
            "fields": {
              "cls": "class",
              "scope": "scope"
            }
          },
          "inputs": [
            {
              "id": "class",
              "label": "Kind",
              "help": "Only records of one kind",
              "kind": "choice",
              "choices": [
                {
                  "value": "decision",
                  "label": "A decision"
                },
                {
                  "value": "constraint",
                  "label": "A constraint"
                },
                {
                  "value": "incident",
                  "label": "An incident"
                },
                {
                  "value": "pattern",
                  "label": "A pattern"
                },
                {
                  "value": "fact",
                  "label": "A fact"
                },
                {
                  "value": "risk",
                  "label": "A risk"
                },
                {
                  "value": "runbook",
                  "label": "A runbook"
                },
                {
                  "value": "architecture",
                  "label": "Architecture"
                },
                {
                  "value": "ownership",
                  "label": "Who owns what"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "every kind"
              },
              "typed": {
                "flag": "--class"
              }
            },
            {
              "id": "scope",
              "label": "Where it applies",
              "help": "Only records for this session, project or team",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session",
                  "help": "Given to this session's turns only."
                },
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Given to work in this project."
                },
                {
                  "value": "team",
                  "label": "Shared with the team",
                  "help": "Part of what a team handoff carries."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "everywhere"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "remember",
          "label": "Remember something",
          "word": "add",
          "line": "/memory add <kind> [--detail <detail>] [--tags <tags>] [--scope <where it applies>] [--session <from session>] [--task <from task>] [--file <from file>] <summary...>",
          "sentence": "\"{summary}\" will be remembered as {class} for {scope} until you change it.",
          "done": "Remembered \"{summary}\".",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "forget",
          "operator": {
            "method": "memory.records.add",
            "fields": {
              "cls": "class",
              "summary": "summary",
              "detail": "detail",
              "scope": "scope"
            }
          },
          "inputs": [
            {
              "id": "class",
              "label": "Kind",
              "help": "What sort of thing it is",
              "kind": "choice",
              "choices": [
                {
                  "value": "decision",
                  "label": "A decision"
                },
                {
                  "value": "constraint",
                  "label": "A constraint"
                },
                {
                  "value": "incident",
                  "label": "An incident"
                },
                {
                  "value": "pattern",
                  "label": "A pattern"
                },
                {
                  "value": "fact",
                  "label": "A fact"
                },
                {
                  "value": "risk",
                  "label": "A risk"
                },
                {
                  "value": "runbook",
                  "label": "A runbook"
                },
                {
                  "value": "architecture",
                  "label": "Architecture"
                },
                {
                  "value": "ownership",
                  "label": "Who owns what"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "summary",
              "label": "Summary",
              "help": "One line that says it",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "detail",
              "label": "Detail",
              "help": "More about it, as long as you like",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--detail"
              }
            },
            {
              "id": "tags",
              "label": "Tags",
              "help": "Words to find it by, separated by commas",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--tags"
              }
            },
            {
              "id": "scope",
              "label": "Where it applies",
              "help": "Where it applies",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session",
                  "help": "Given to this session's turns only."
                },
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Given to work in this project."
                },
                {
                  "value": "team",
                  "label": "Shared with the team",
                  "help": "Part of what a team handoff carries."
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "session",
              "label": "From session",
              "help": "The session it came from",
              "kind": "text",
              "freeTextReason": "a session id",
              "required": {
                "default": "",
                "defaultMeans": "this session"
              },
              "typed": {
                "flag": "--session"
              }
            },
            {
              "id": "task",
              "label": "From task",
              "help": "The task it came from",
              "kind": "text",
              "freeTextReason": "a task id",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--task"
              }
            },
            {
              "id": "file",
              "label": "From file",
              "help": "The file it is about",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--file"
              }
            }
          ]
        },
        {
          "id": "search",
          "label": "Search memory",
          "word": "search",
          "line": "/memory search [--class <kind>] [--scope <where it applies>] [--limit <at most>] [--semantic] [<words...>]",
          "sentence": "Finds memory records that match {query}.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "memory.records.search",
            "fields": {
              "query": "query"
            }
          },
          "inputs": [
            {
              "id": "query",
              "label": "Words",
              "help": "What to look for",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "every record"
              },
              "typed": {
                "tail": true
              }
            },
            {
              "id": "class",
              "label": "Kind",
              "help": "Only records of one kind",
              "kind": "choice",
              "choices": [
                {
                  "value": "decision",
                  "label": "A decision"
                },
                {
                  "value": "constraint",
                  "label": "A constraint"
                },
                {
                  "value": "incident",
                  "label": "An incident"
                },
                {
                  "value": "pattern",
                  "label": "A pattern"
                },
                {
                  "value": "fact",
                  "label": "A fact"
                },
                {
                  "value": "risk",
                  "label": "A risk"
                },
                {
                  "value": "runbook",
                  "label": "A runbook"
                },
                {
                  "value": "architecture",
                  "label": "Architecture"
                },
                {
                  "value": "ownership",
                  "label": "Who owns what"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "every kind"
              },
              "typed": {
                "flag": "--class"
              }
            },
            {
              "id": "scope",
              "label": "Where it applies",
              "help": "Only records for this session, project or team",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session",
                  "help": "Given to this session's turns only."
                },
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Given to work in this project."
                },
                {
                  "value": "team",
                  "label": "Shared with the team",
                  "help": "Part of what a team handoff carries."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "everywhere"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "limit",
              "label": "At most",
              "help": "How many records to show",
              "kind": "number",
              "freeTextReason": "a whole number",
              "required": {
                "default": "",
                "defaultMeans": "the usual number"
              },
              "typed": {
                "flag": "--limit"
              }
            },
            {
              "id": "meaning",
              "label": "Match by",
              "help": "The words, or what they mean",
              "kind": "choice",
              "choices": [
                {
                  "value": "words",
                  "label": "The words"
                },
                {
                  "value": "meaning",
                  "label": "What they mean",
                  "help": "Uses the semantic search index."
                }
              ],
              "required": {
                "default": "words",
                "defaultMeans": "the words"
              },
              "typed": {
                "flag": "--semantic",
                "switchOn": "meaning"
              }
            }
          ]
        },
        {
          "id": "see-record",
          "label": "See one record",
          "word": "show",
          "line": "/memory show <record>",
          "sentence": "Shows {record} in full: where it applies, its detail, tags, where it came from and what it is linked to.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "memory.records.get",
            "fields": {
              "id": "record"
            }
          },
          "inputs": [
            {
              "id": "record",
              "label": "Record",
              "help": "Your memory records",
              "kind": "choice",
              "choices": {
                "list": "memory.records",
                "allowOther": {
                  "reason": "a record id from /memory list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "edit",
          "label": "Correct a record",
          "word": "edit",
          "line": "/memory edit <record> [--summary <summary>] [--detail <detail>] [--tags <tags>] [--scope <where it applies>]",
          "sentence": "{record} will be corrected in place (its id, kind, origin and links stay) until you change it.",
          "done": "Corrected {record}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "memory.records.update",
            "fields": {
              "id": "record",
              "summary": "summary",
              "detail": "detail",
              "scope": "scope"
            }
          },
          "inputs": [
            {
              "id": "record",
              "label": "Record",
              "help": "Your memory records",
              "kind": "choice",
              "choices": {
                "list": "memory.records",
                "allowOther": {
                  "reason": "a record id from /memory list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "summary",
              "label": "Summary",
              "help": "The new one-line summary",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--summary"
              }
            },
            {
              "id": "detail",
              "label": "Detail",
              "help": "More about it, as long as you like",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--detail"
              }
            },
            {
              "id": "tags",
              "label": "Tags",
              "help": "Words to find it by, separated by commas",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--tags"
              }
            },
            {
              "id": "scope",
              "label": "Where it applies",
              "help": "Where it applies",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session",
                  "help": "Given to this session's turns only."
                },
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Given to work in this project."
                },
                {
                  "value": "team",
                  "label": "Shared with the team",
                  "help": "Part of what a team handoff carries."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "review",
          "label": "Say whether a record is still right",
          "word": "review",
          "line": "/memory review <record> <it is> [--confidence <confidence>] [--reason <why>] [--by <reviewed by>]",
          "sentence": "{record} will be marked \"{state}\" until you change it.",
          "done": "Marked {record} as {state}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "memory.records.update-review",
            "fields": {
              "id": "record",
              "state": "state"
            }
          },
          "inputs": [
            {
              "id": "record",
              "label": "Record",
              "help": "Your memory records",
              "kind": "choice",
              "choices": {
                "list": "memory.records",
                "allowOther": {
                  "reason": "a record id from /memory list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "state",
              "label": "It is",
              "help": "Whether it still holds",
              "kind": "choice",
              "choices": [
                {
                  "value": "fresh",
                  "label": "Not reviewed yet"
                },
                {
                  "value": "reviewed",
                  "label": "Reviewed and right"
                },
                {
                  "value": "stale",
                  "label": "Out of date"
                },
                {
                  "value": "contradicted",
                  "label": "Contradicted by something newer"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "confidence",
              "label": "Confidence",
              "help": "How sure, from 0 to 100",
              "kind": "number",
              "freeTextReason": "a number from 0 to 100",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--confidence"
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "A note for whoever reads it next",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "no note"
              },
              "typed": {
                "flag": "--reason"
              }
            },
            {
              "id": "by",
              "label": "Reviewed by",
              "help": "Who reviewed it",
              "kind": "text",
              "freeTextReason": "a name",
              "required": {
                "default": "",
                "defaultMeans": "you (operator)"
              },
              "typed": {
                "flag": "--by"
              }
            }
          ]
        },
        {
          "id": "move",
          "label": "Change where a record applies",
          "word": "promote",
          "line": "/memory promote <record> <applies to>",
          "sentence": "{record} will apply to {scope} until you change it.",
          "done": "{record} now applies to {scope}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "memory.records.update",
            "fields": {
              "id": "record",
              "scope": "scope"
            }
          },
          "inputs": [
            {
              "id": "record",
              "label": "Record",
              "help": "Your memory records",
              "kind": "choice",
              "choices": {
                "list": "memory.records",
                "allowOther": {
                  "reason": "a record id from /memory list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "scope",
              "label": "Applies to",
              "help": "This session, this project or the team",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session",
                  "help": "Given to this session's turns only."
                },
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Given to work in this project."
                },
                {
                  "value": "team",
                  "label": "Shared with the team",
                  "help": "Part of what a team handoff carries."
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "link",
          "label": "Link two records",
          "word": "link",
          "line": "/memory link <from> <to> <how they relate...>",
          "sentence": "{from} will be linked to {to} as \"{relation}\" until you change it.",
          "done": "Linked {from} to {to} ({relation}).",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "memory.records.links.add",
            "fields": {
              "fromId": "from",
              "toId": "to",
              "relation": "relation"
            }
          },
          "inputs": [
            {
              "id": "from",
              "label": "From",
              "help": "The record the link starts at",
              "kind": "choice",
              "choices": {
                "list": "memory.records",
                "allowOther": {
                  "reason": "a record id from /memory list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "to",
              "label": "To",
              "help": "The record it points to",
              "kind": "choice",
              "choices": {
                "list": "memory.records",
                "allowOther": {
                  "reason": "a record id from /memory list"
                }
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "relation",
              "label": "How they relate",
              "help": "A word such as supersedes, explains or depends-on",
              "kind": "text",
              "freeTextReason": "your own word for it",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "forget",
          "label": "Forget a record",
          "word": "remove",
          "line": "/memory remove <record>",
          "sentence": "Memory record {record} and its links will be deleted and cannot be recovered.",
          "done": "Forgot {record}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "memory.records.delete",
            "fields": {
              "id": "record"
            }
          },
          "inputs": [
            {
              "id": "record",
              "label": "Record",
              "help": "Your memory records",
              "kind": "choice",
              "choices": {
                "list": "memory.records",
                "allowOther": {
                  "reason": "a record id from /memory list"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "see-queue",
          "label": "See records waiting for review",
          "word": "queue",
          "line": "/memory queue [<at most>] [--scope <where it applies>]",
          "sentence": "Lists the records whose review is due, least sure first.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "memory.review-queue",
            "fields": {}
          },
          "inputs": [
            {
              "id": "limit",
              "label": "At most",
              "help": "How many to show",
              "kind": "number",
              "freeTextReason": "a whole number",
              "required": {
                "default": "10",
                "defaultMeans": "ten"
              },
              "typed": {
                "position": 1
              }
            },
            {
              "id": "scope",
              "label": "Where it applies",
              "help": "Only records for this session, project or team",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session",
                  "help": "Given to this session's turns only."
                },
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Given to work in this project."
                },
                {
                  "value": "team",
                  "label": "Shared with the team",
                  "help": "Part of what a team handoff carries."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "everywhere"
              },
              "typed": {
                "flag": "--scope"
              }
            }
          ]
        },
        {
          "id": "explain",
          "label": "See what memory a task would be given",
          "word": "explain",
          "line": "/memory explain [--scope <files it would change>]... <task...>",
          "sentence": "Shows the reviewed memory that would be given to \"{task}\", and why.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is worked out from this app's own memory store."
          },
          "inputs": [
            {
              "id": "task",
              "label": "Task",
              "help": "The task, the way you would ask for it",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "paths",
              "label": "Files it would change",
              "help": "Paths the task would write, separated by commas",
              "kind": "path",
              "freeTextReason": "a path in this project",
              "required": {
                "default": "",
                "defaultMeans": "any"
              },
              "typed": {
                "flag": "--scope",
                "repeats": true
              }
            }
          ]
        },
        {
          "id": "see-injections",
          "label": "See what memory a turn was given",
          "word": "injections",
          "line": "/memory injections [<agent>]",
          "sentence": "Shows the memory each recent turn of {agent} was given.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is recorded in the terminal app's session."
          },
          "inputs": [
            {
              "id": "agent",
              "label": "Agent",
              "help": "An agent this session started",
              "kind": "text",
              "freeTextReason": "an agent id from /agents",
              "required": {
                "default": "",
                "defaultMeans": "this session's own turns"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "sync-files",
          "label": "Write memory as files",
          "word": "sync-files",
          "line": "/memory sync-files [--dir <folder>]",
          "sentence": "Each project and team record is written as a file in {dir} and committed in that folder's own repository, until you change it; a file you edited is kept as it is.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Memory files live in the terminal app's project."
          },
          "inputs": [
            {
              "id": "dir",
              "label": "Folder",
              "help": "Where the memory files are kept",
              "kind": "path",
              "freeTextReason": "a folder in this project",
              "required": {
                "default": "",
                "defaultMeans": "the memory files folder in the settings"
              },
              "typed": {
                "flag": "--dir"
              }
            }
          ]
        },
        {
          "id": "review-files",
          "label": "See what edited memory files would change",
          "word": "review-files",
          "line": "/memory review-files [--dir <folder>]",
          "sentence": "Compares the memory files in {dir} with memory and lists what your edits would change; nothing is changed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Memory files live in the terminal app's project."
          },
          "inputs": [
            {
              "id": "dir",
              "label": "Folder",
              "help": "Where the memory files are kept",
              "kind": "path",
              "freeTextReason": "a folder in this project",
              "required": {
                "default": "",
                "defaultMeans": "the memory files folder in the settings"
              },
              "typed": {
                "flag": "--dir"
              }
            }
          ]
        },
        {
          "id": "apply-files",
          "label": "Take edited memory files into memory",
          "word": "apply-files",
          "line": "/memory apply-files <change> [--dir <folder>]",
          "sentence": "The change {proposal} from your memory files will be made in memory until you change it; a deleted file deletes its record.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "it turns file edits into memory",
            "instead": "Ask the owner to review the files and apply them; /memory review-files lists the changes."
          },
          "operator": {
            "terminalOnly": "Memory files live in the terminal app's project."
          },
          "inputs": [
            {
              "id": "dir",
              "label": "Folder",
              "help": "Where the memory files are kept",
              "kind": "path",
              "freeTextReason": "a folder in this project",
              "required": {
                "default": "",
                "defaultMeans": "the memory files folder in the settings"
              },
              "typed": {
                "flag": "--dir"
              }
            },
            {
              "id": "proposal",
              "label": "Change",
              "help": "Changes your file edits would make",
              "kind": "choice",
              "choices": {
                "list": "memory.file-proposals",
                "dependsOn": "dir",
                "allowOther": {
                  "reason": "a record id from \"See what edited memory files would change\", or all"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "save",
          "label": "Save memory to a file",
          "word": "export",
          "line": "/memory export <file> [--scope <where it applies>] [--class <kind>]",
          "sentence": "Memory records and their links ({scope}) will be written to {path}, which is replaced if it is there, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "memory.records.export",
            "fields": {
              "scope": "scope",
              "cls": "class"
            }
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A path in this project, or an absolute path",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "scope",
              "label": "Where it applies",
              "help": "Only records for this session, project or team",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "This session",
                  "help": "Given to this session's turns only."
                },
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Given to work in this project."
                },
                {
                  "value": "team",
                  "label": "Shared with the team",
                  "help": "Part of what a team handoff carries."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "everywhere"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "class",
              "label": "Kind",
              "help": "Only records of one kind",
              "kind": "choice",
              "choices": [
                {
                  "value": "decision",
                  "label": "A decision"
                },
                {
                  "value": "constraint",
                  "label": "A constraint"
                },
                {
                  "value": "incident",
                  "label": "An incident"
                },
                {
                  "value": "pattern",
                  "label": "A pattern"
                },
                {
                  "value": "fact",
                  "label": "A fact"
                },
                {
                  "value": "risk",
                  "label": "A risk"
                },
                {
                  "value": "runbook",
                  "label": "A runbook"
                },
                {
                  "value": "architecture",
                  "label": "Architecture"
                },
                {
                  "value": "ownership",
                  "label": "Who owns what"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "every kind"
              },
              "typed": {
                "flag": "--class"
              }
            }
          ]
        },
        {
          "id": "inspect",
          "label": "Read a memory file before loading it",
          "word": "inspect",
          "line": "/memory inspect <file>",
          "sentence": "Shows what the memory file {path} holds; nothing is loaded.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is read on the terminal app's machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A path in this project, or an absolute path",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "load",
          "label": "Load memory from a file",
          "word": "import",
          "line": "/memory import <file>",
          "sentence": "The records and links in {path} will be added to memory (a record already there is left as it is) until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "memory.records.import",
            "fields": {}
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A path in this project, or an absolute path",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "see-copies",
          "label": "See copies of memory",
          "word": "snapshots",
          "line": "/memory snapshots",
          "sentence": "Lists the copies of memory taken each day, before a migration and before a restore, newest first.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "memory.snapshots.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "restore",
          "label": "Replace all memory with a copy",
          "word": "restore",
          "line": "/memory restore <copy>",
          "sentence": "Every memory record, link and waiting proposal will be replaced by those in {copy}, until you change it; the records you have now are copied first, so restoring that copy puts them back.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "it replaces every memory record",
            "instead": "Ask the owner to choose \"Replace all memory with a copy\" in /memory."
          },
          "undoneBy": "restore",
          "operator": {
            "method": "memory.snapshots.restore",
            "fields": {
              "snapshot": "copy"
            }
          },
          "inputs": [
            {
              "id": "copy",
              "label": "Copy",
              "help": "The copies of memory, newest first",
              "kind": "choice",
              "choices": {
                "list": "memory.copies",
                "allowOther": {
                  "reason": "latest, or a date such as 2026-11-19"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "see-index",
          "label": "See the search index",
          "word": "index",
          "line": "/memory index",
          "sentence": "Shows the semantic search index: whether it works, how many records it holds and how many wait to be embedded again.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "memory.vector.stats",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "rebuild-index",
          "label": "Rebuild the search index",
          "word": "rebuild-index",
          "line": "/memory rebuild-index",
          "sentence": "Every record is embedded again with the current provider, so semantic search covers all of memory; nothing is lost.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "memory.vector.rebuild",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "capture",
          "label": "Remember an incident or a setting's state",
          "word": "capture",
          "line": "/memory capture <what> [<which>]",
          "sentence": "{what} {which} will be remembered as a record until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "forget",
          "operator": {
            "terminalOnly": "It reads what the terminal app holds."
          },
          "inputs": [
            {
              "id": "what",
              "label": "What",
              "help": "What to remember",
              "kind": "choice",
              "choices": [
                {
                  "value": "incident",
                  "label": "An incident report",
                  "help": "The latest one, or one by id"
                },
                {
                  "value": "policy",
                  "label": "The last policy check",
                  "help": "What the last policy preflight found"
                },
                {
                  "value": "mcp",
                  "label": "An MCP server's trust",
                  "help": "Its trust level and held-back tools"
                },
                {
                  "value": "plugin",
                  "label": "A plugin's trust",
                  "help": "Whether it is held back, and why"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "which",
              "label": "Which",
              "help": "The incident id (or latest), the server or the plugin",
              "kind": "text",
              "freeTextReason": "its name or id",
              "required": {
                "default": "",
                "defaultMeans": "the latest incident"
              },
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "open-screen",
          "label": "Open the memory screen",
          "word": "open",
          "line": "/memory open",
          "sentence": "Opens the full-screen view of memory records.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        }
      ]
    },
    {
      "name": "my-skills",
      "title": "My skills",
      "summary": "Keep the Agent's own skills: step-by-step procedures it follows when a task matches",
      "group": "Extensions",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See your skills",
          "word": "list",
          "line": "/my-skills list",
          "sentence": "Lists every Agent-local skill with its state, review and readiness.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "enabled",
          "label": "See the skills that are on",
          "word": "enabled",
          "line": "/my-skills enabled",
          "sentence": "Lists the skills that are switched on.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "attention",
          "label": "See skills that need setting up",
          "word": "attention",
          "line": "/my-skills attention",
          "sentence": "Lists skills missing an environment variable or a command they need.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "search",
          "label": "Search your skills",
          "word": "search",
          "line": "/my-skills search <looking for...>",
          "sentence": "Lists skills that match \"{query}\".",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "query",
              "label": "Looking for",
              "help": "Words to search for",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "show",
          "label": "See one skill",
          "word": "show",
          "line": "/my-skills show <skill>",
          "sentence": "Shows {skill}'s procedure, requirements, review and origin.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "create",
          "label": "Make a skill",
          "word": "create",
          "line": "/my-skills create [--name <name>] [--description <what it is for>] [--triggers <when it applies>] [--tags <tags>] [--requires-env <environment it needs>] [--requires-command <commands it needs>] [--enabled] <steps...>",
          "sentence": "A skill {name} (\"{description}\") is kept until you change it; its steps: {procedure}",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "delete",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A short name",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "description",
              "label": "What it is for",
              "help": "One line the model matches tasks against",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "flag": "--description"
              }
            },
            {
              "id": "procedure",
              "label": "Steps",
              "help": "What to do, step by step",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "triggers",
              "label": "When it applies",
              "help": "Words that bring it up, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "only when asked for"
              },
              "typed": {
                "flag": "--triggers"
              }
            },
            {
              "id": "tags",
              "label": "Tags",
              "help": "Tags, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--tags"
              }
            },
            {
              "id": "env",
              "label": "Environment it needs",
              "help": "Environment variable names, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--requires-env"
              }
            },
            {
              "id": "commands",
              "label": "Commands it needs",
              "help": "Program names, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--requires-command"
              }
            },
            {
              "id": "enabled",
              "label": "Switch it on now",
              "help": "Switch it on at once, or after you review it",
              "kind": "yes-no",
              "choices": [
                {
                  "value": "no",
                  "label": "No, after a review"
                },
                {
                  "value": "yes",
                  "label": "Yes"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "off until you review it"
              },
              "typed": {
                "flag": "--enabled"
              }
            }
          ]
        },
        {
          "id": "update",
          "label": "Change a skill",
          "word": "update",
          "line": "/my-skills update <skill> [--name <name>] [--description <what it is for>] [--procedure <steps>] [--triggers <when it applies>] [--tags <tags>] [--requires-env <environment it needs>] [--requires-command <commands it needs>]",
          "sentence": "{skill} is changed to what you gave until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "name",
              "label": "Name",
              "help": "A new name",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "description",
              "label": "What it is for",
              "help": "A new line",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--description"
              }
            },
            {
              "id": "procedure",
              "label": "Steps",
              "help": "New steps",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--procedure"
              }
            },
            {
              "id": "triggers",
              "label": "When it applies",
              "help": "Words that bring it up, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--triggers"
              }
            },
            {
              "id": "tags",
              "label": "Tags",
              "help": "Tags, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--tags"
              }
            },
            {
              "id": "env",
              "label": "Environment it needs",
              "help": "Environment variable names, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--requires-env"
              }
            },
            {
              "id": "commands",
              "label": "Commands it needs",
              "help": "Program names, separated by commas",
              "kind": "text",
              "freeTextReason": "names you choose",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--requires-command"
              }
            }
          ]
        },
        {
          "id": "enable",
          "label": "Switch a skill on",
          "word": "enable",
          "line": "/my-skills enable <skill>",
          "sentence": "The model may follow {skill} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "disable",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "disable",
          "label": "Switch a skill off",
          "word": "disable",
          "line": "/my-skills disable <skill>",
          "sentence": "The model stops following {skill} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "enable",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "review",
          "label": "Mark a skill reviewed",
          "word": "review",
          "line": "/my-skills review <skill>",
          "sentence": "{skill} is marked reviewed by you until you change it, so it may be switched on.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "stale",
          "label": "Mark a skill out of date",
          "word": "stale",
          "line": "/my-skills stale <skill> <why...>",
          "sentence": "{skill} is marked out of date (\"{reason}\") until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "What is out of date",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "delete",
          "label": "Delete a skill",
          "word": "delete",
          "line": "/my-skills delete <skill>",
          "sentence": "{skill} is removed from the Agent-local registry.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "discover",
          "label": "See skill files found on disk",
          "word": "discover",
          "line": "/my-skills discover",
          "sentence": "Lists SKILL.md and .md skill files in the project and global skill folders.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "import-discovered",
          "label": "Import a skill file found on disk",
          "word": "import-discovered",
          "line": "/my-skills import-discovered <skill file> [--enabled]",
          "sentence": "{file} is copied into your Agent-local skills, off until you review it unless you switch it on, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "delete",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "file",
              "label": "Skill file",
              "help": "Skill files found on disk",
              "kind": "choice",
              "choices": {
                "list": "my-skills.discovered"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "enabled",
              "label": "Switch it on now",
              "help": "Switch it on at once, or after you review it",
              "kind": "yes-no",
              "choices": [
                {
                  "value": "no",
                  "label": "No, after a review"
                },
                {
                  "value": "yes",
                  "label": "Yes"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "off until you review it"
              },
              "typed": {
                "flag": "--enabled"
              }
            }
          ]
        },
        {
          "id": "import-standard",
          "label": "Import a shared SKILL.md",
          "word": "import-standard",
          "line": "/my-skills import-standard <skill.md file>",
          "sentence": "The skill in {path} is added, off until you review it, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "delete",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "SKILL.md file",
              "help": "A skill in the shared SKILL.md format",
              "kind": "path",
              "freeTextReason": "a file path on this machine",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "export-standard",
          "label": "Save a skill as a shared SKILL.md",
          "word": "export-standard",
          "line": "/my-skills export-standard <skill> <folder> [--overwrite]",
          "sentence": "{skill} is written as a SKILL.md into {dir}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "Your Agent-local skills",
              "kind": "choice",
              "choices": {
                "list": "my-skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "dir",
              "label": "Folder",
              "help": "Where to write its SKILL.md",
              "kind": "path",
              "freeTextReason": "a folder on this machine",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "overwrite",
              "label": "If a SKILL.md is there",
              "help": "Keep it, or replace it",
              "kind": "choice",
              "choices": [
                {
                  "value": "keep",
                  "label": "Refuse and keep it"
                },
                {
                  "value": "replace",
                  "label": "Replace it",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "keep",
                "defaultMeans": "refuse and keep it"
              },
              "typed": {
                "flag": "--overwrite",
                "switchOn": "replace"
              }
            }
          ]
        },
        {
          "id": "bundles",
          "label": "See your skill bundles",
          "word": "bundles",
          "line": "/my-skills bundles",
          "sentence": "Lists every skill bundle with its state, review and readiness.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "bundles-enabled",
          "label": "See the bundles that are on",
          "word": "bundles-enabled",
          "line": "/my-skills bundles-enabled",
          "sentence": "Lists the skill bundles that are switched on.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "bundles-attention",
          "label": "See bundles that need setting up",
          "word": "bundles-attention",
          "line": "/my-skills bundles-attention",
          "sentence": "Lists bundles missing a skill or something a skill needs.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "bundle-search",
          "label": "Search your skill bundles",
          "word": "bundle-search",
          "line": "/my-skills bundle-search <looking for...>",
          "sentence": "Lists skill bundles that match \"{query}\".",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "query",
              "label": "Looking for",
              "help": "Words to search for",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "bundle-show",
          "label": "See one skill bundle",
          "word": "bundle-show",
          "line": "/my-skills bundle-show <bundle>",
          "sentence": "Shows {bundle}'s skills, readiness and review.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "bundle",
              "label": "Bundle",
              "help": "Your skill bundles",
              "kind": "choice",
              "choices": {
                "list": "my-skills.bundles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "bundle-create",
          "label": "Make a skill bundle",
          "word": "bundle-create",
          "line": "/my-skills bundle-create [--name <name>] [--description <what it is for>] [--skills <skills in it>] [--enabled]",
          "sentence": "A skill bundle {name} (\"{description}\") of {skills} is kept until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "bundle-delete",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A short name",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "description",
              "label": "What it is for",
              "help": "One line",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "flag": "--description"
              }
            },
            {
              "id": "skills",
              "label": "Skills in it",
              "help": "Skill ids, separated by commas",
              "kind": "text",
              "freeTextReason": "skill ids from /my-skills list",
              "required": true,
              "typed": {
                "flag": "--skills"
              }
            },
            {
              "id": "enabled",
              "label": "Switch it on now",
              "help": "Switch it on at once, or after you review it",
              "kind": "yes-no",
              "choices": [
                {
                  "value": "no",
                  "label": "No, after a review"
                },
                {
                  "value": "yes",
                  "label": "Yes"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "off until you review it"
              },
              "typed": {
                "flag": "--enabled"
              }
            }
          ]
        },
        {
          "id": "bundle-update",
          "label": "Change a skill bundle",
          "word": "bundle-update",
          "line": "/my-skills bundle-update <bundle> [--name <name>] [--description <what it is for>] [--skills <skills in it>]",
          "sentence": "{bundle} is changed to what you gave until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "bundle",
              "label": "Bundle",
              "help": "Your skill bundles",
              "kind": "choice",
              "choices": {
                "list": "my-skills.bundles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "name",
              "label": "Name",
              "help": "A new name",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "description",
              "label": "What it is for",
              "help": "A new line",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--description"
              }
            },
            {
              "id": "skills",
              "label": "Skills in it",
              "help": "Skill ids, separated by commas",
              "kind": "text",
              "freeTextReason": "skill ids from /my-skills list",
              "required": {
                "default": "",
                "defaultMeans": "unchanged"
              },
              "typed": {
                "flag": "--skills"
              }
            }
          ]
        },
        {
          "id": "bundle-enable",
          "label": "Switch a skill bundle on",
          "word": "bundle-enable",
          "line": "/my-skills bundle-enable <bundle>",
          "sentence": "The skills of {bundle} are in use until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "bundle-disable",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "bundle",
              "label": "Bundle",
              "help": "Your skill bundles",
              "kind": "choice",
              "choices": {
                "list": "my-skills.bundles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "bundle-disable",
          "label": "Switch a skill bundle off",
          "word": "bundle-disable",
          "line": "/my-skills bundle-disable <bundle>",
          "sentence": "{bundle} is out of use until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "bundle-enable",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "bundle",
              "label": "Bundle",
              "help": "Your skill bundles",
              "kind": "choice",
              "choices": {
                "list": "my-skills.bundles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "bundle-review",
          "label": "Mark a skill bundle reviewed",
          "word": "bundle-review",
          "line": "/my-skills bundle-review <bundle>",
          "sentence": "{bundle} is marked reviewed by you until you change it, so it may be switched on.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "bundle",
              "label": "Bundle",
              "help": "Your skill bundles",
              "kind": "choice",
              "choices": {
                "list": "my-skills.bundles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "bundle-stale",
          "label": "Mark a skill bundle out of date",
          "word": "bundle-stale",
          "line": "/my-skills bundle-stale <bundle> <why...>",
          "sentence": "{bundle} is marked out of date (\"{reason}\") until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "bundle",
              "label": "Bundle",
              "help": "Your skill bundles",
              "kind": "choice",
              "choices": {
                "list": "my-skills.bundles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "What is out of date",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "bundle-delete",
          "label": "Delete a skill bundle",
          "word": "bundle-delete",
          "line": "/my-skills bundle-delete <bundle>",
          "sentence": "{bundle} is removed from the Agent-local registry; its skills stay.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "Agent-local skills are kept on this machine."
          },
          "inputs": [
            {
              "id": "bundle",
              "label": "Bundle",
              "help": "Your skill bundles",
              "kind": "choice",
              "choices": {
                "list": "my-skills.bundles"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "payments",
      "title": "Payments",
      "summary": "Cards, purchases, and what may be bought without asking",
      "group": "Payments",
      "report": "see-cards",
      "actions": [
        {
          "id": "see-cards",
          "label": "See your cards",
          "word": "cards",
          "line": "/payments cards",
          "sentence": "Shows the payment cards on the selected daemon (label, kind, last four digits and expiry, never the number) and the addresses purchases use.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "payments.cards.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "see-waiting",
          "label": "See what is waiting for your answer",
          "word": "pending",
          "line": "/payments pending",
          "sentence": "Opens the purchases waiting for you: approve or deny one, stop a checkout, or type a card's security code; each answer is asked again before it is sent.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "ownerOnly": {
            "reason": "answering a purchase is the owner's own act",
            "instead": "Ask the owner to choose it from /payments."
          },
          "operator": {
            "terminalOnly": "The web UI answers purchases on its Purchases screen."
          },
          "inputs": []
        },
        {
          "id": "approve-ahead",
          "label": "Approve one purchase ahead of time",
          "word": "approve",
          "line": "/payments approve <shop> [--most <at most>] <what may be bought...>",
          "sentence": "One purchase of \"{item}\" from {shop}, of at most {most}, begun in the next five minutes, will need no further answer; it is used once and lasts for this session only.",
          "done": "Approved ahead of time: \"{item}\" from {shop}, at most {most}.",
          "touches": "another-machine",
          "lasts": "session",
          "risk": "spends-money",
          "riskWords": "spends money",
          "ownerOnly": {
            "reason": "approving a purchase is the owner's own act",
            "instead": "Ask the owner to choose it from /payments."
          },
          "operator": {
            "method": "payments.checkout.approve",
            "fields": {
              "merchantDomain": "shop",
              "item": "item",
              "amount": "most",
              "confirm": "=true"
            }
          },
          "inputs": [
            {
              "id": "shop",
              "label": "Shop",
              "help": "Shops you have bought from, or type one",
              "kind": "choice",
              "choices": {
                "list": "payments.shops",
                "allowOther": {
                  "reason": "a shop you have not bought from yet (its web address, such as shop.example)"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "most",
              "label": "At most",
              "help": "The most it may cost, in your payment currency, such as 25.00",
              "kind": "money",
              "required": true,
              "typed": {
                "flag": "--most"
              }
            },
            {
              "id": "item",
              "label": "What may be bought",
              "help": "In your own words; a purchase must name exactly this",
              "kind": "text",
              "freeTextReason": "your own words for the item",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "allow-repeat",
          "label": "Allow a repeat purchase",
          "word": "repeat",
          "line": "/payments repeat [--shop <shop>]... [--item <what may be bought>] [--each <most per purchase>] [--per-period <most in any period>] [--days <period>] [--until <last day>]",
          "sentence": "A schedule may buy \"{item}\" from {shop} without asking: at most {each} each time and {per-period} in any {days} days, until you change it or its last day passes. Every other spending limit still applies.",
          "done": "Allowed: \"{item}\" from {shop}. Stop it any time: Stop a repeat purchase.",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "spends-money",
          "riskWords": "spends money",
          "ownerOnly": {
            "reason": "allowing a repeat purchase is the owner's own act",
            "instead": "Ask the owner to choose it from /payments."
          },
          "undoneBy": "stop-repeat",
          "operator": {
            "method": "payments.standing.create",
            "fields": {
              "merchants": "shop:lines",
              "item": "item",
              "maxPerPurchase": "each",
              "maxPerPeriod": "per-period",
              "periodDays": "days:number",
              "expires": "until",
              "confirm": "=true"
            }
          },
          "inputs": [
            {
              "id": "shop",
              "label": "Shop",
              "help": "Shops you have bought from, or type one; more than one with --shop again",
              "kind": "choice",
              "choices": {
                "list": "payments.shops",
                "allowOther": {
                  "reason": "a shop you have not bought from yet (its web address, such as shop.example)"
                }
              },
              "required": true,
              "typed": {
                "flag": "--shop",
                "repeats": true
              }
            },
            {
              "id": "item",
              "label": "What may be bought",
              "help": "In your own words; a purchase must name exactly this",
              "kind": "text",
              "freeTextReason": "your own words for the item",
              "required": true,
              "typed": {
                "flag": "--item"
              }
            },
            {
              "id": "each",
              "label": "Most per purchase",
              "help": "In your payment currency, such as 60.00",
              "kind": "money",
              "required": true,
              "typed": {
                "flag": "--each"
              }
            },
            {
              "id": "per-period",
              "label": "Most in any period",
              "help": "All purchases under it together, such as 120.00",
              "kind": "money",
              "required": true,
              "typed": {
                "flag": "--per-period"
              }
            },
            {
              "id": "days",
              "label": "Period",
              "help": "How many days the period is",
              "kind": "choice",
              "choices": [
                {
                  "value": "7",
                  "label": "7 days"
                },
                {
                  "value": "30",
                  "label": "30 days"
                },
                {
                  "value": "90",
                  "label": "90 days"
                },
                {
                  "value": "365",
                  "label": "A year"
                }
              ],
              "required": {
                "default": "30",
                "defaultMeans": "30 days"
              },
              "typed": {
                "flag": "--days"
              }
            },
            {
              "id": "until",
              "label": "Last day",
              "help": "A date such as 2027-06-30; blank for no end date",
              "kind": "date-time",
              "required": {
                "default": "",
                "defaultMeans": "no end date"
              },
              "typed": {
                "flag": "--until"
              }
            }
          ]
        },
        {
          "id": "see-repeats",
          "label": "See repeat purchases you have allowed",
          "word": "repeats",
          "line": "/payments repeats",
          "sentence": "Shows each repeat purchase you have allowed: what, from which shops, the limits, and what is left this period.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "payments.standing.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "stop-repeat",
          "label": "Stop a repeat purchase",
          "word": "stop-repeat",
          "line": "/payments stop-repeat <repeat purchase>",
          "sentence": "No new purchase will start under {repeat} {lasts}; one already running keeps its window, where you can still stop it.",
          "done": "Stopped {repeat}.",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "allow-repeat",
          "operator": {
            "method": "payments.standing.delete",
            "fields": {
              "id": "repeat",
              "confirm": "=true"
            }
          },
          "inputs": [
            {
              "id": "repeat",
              "label": "Repeat purchase",
              "help": "The repeat purchases you have allowed",
              "kind": "choice",
              "choices": {
                "list": "payments.repeats"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "add-card",
          "label": "Add a card",
          "word": "add-card",
          "line": "/payments add-card",
          "sentence": "You will be asked the card's label, kind, number, expiry, security code and name, each hidden as you type; the card is stored on the selected daemon until you change it.",
          "done": "",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "card details are typed only by the person at the keyboard",
            "instead": "Ask the owner to choose \"Add a card\" in /payments."
          },
          "undoneBy": "remove-card",
          "operator": {
            "terminalOnly": "The web UI adds a card on its own card form under Settings > Payments."
          },
          "inputs": []
        },
        {
          "id": "remove-card",
          "label": "Remove a card",
          "word": "remove-card",
          "line": "/payments remove-card <card>",
          "sentence": "Card {card} (its number, expiry, security code and name) will be deleted from the selected daemon. Cancel it with the issuer too if it should stop working everywhere.",
          "done": "Removed card {card}.",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "ownerOnly": {
            "reason": "removing a card is the owner's own act",
            "instead": "Ask the owner to choose it from /payments."
          },
          "operator": {
            "method": "payments.cards.delete",
            "fields": {
              "id": "card"
            }
          },
          "inputs": [
            {
              "id": "card",
              "label": "Card",
              "help": "The cards on the selected daemon",
              "kind": "choice",
              "choices": {
                "list": "payments.cards"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "set-address",
          "label": "Set your billing or shipping address",
          "word": "address",
          "line": "/payments address <address> [--name <recipient name>] [--line1 <address line 1>] [--line2 <address line 2>] [--city <city>] [--region <state or region>] [--postal-code <postal code>] [--country <country>]",
          "sentence": "Your {kind} address will be set to what you typed (blank fields keep their value) until you change it.",
          "done": "Set your {kind} address.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "an address is typed only by the person at the keyboard",
            "instead": "Ask the owner to choose \"Set your billing or shipping address\" in /payments."
          },
          "operator": {
            "terminalOnly": "The web UI sets addresses under Settings > Payments."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Address",
              "help": "Which address purchases use",
              "kind": "choice",
              "choices": [
                {
                  "value": "billing",
                  "label": "Billing address",
                  "help": "Where the card's statements go."
                },
                {
                  "value": "shipping",
                  "label": "Shipping address",
                  "help": "Where parcels go."
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "name",
              "label": "Recipient name",
              "help": "As it goes on the parcel or the card statement; blank keeps what is set",
              "kind": "text",
              "freeTextReason": "part of your address",
              "required": {
                "default": "",
                "defaultMeans": "keep what is set"
              },
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "line1",
              "label": "Address line 1",
              "help": "Street and number; blank keeps what is set",
              "kind": "text",
              "freeTextReason": "part of your address",
              "required": {
                "default": "",
                "defaultMeans": "keep what is set"
              },
              "typed": {
                "flag": "--line1"
              }
            },
            {
              "id": "line2",
              "label": "Address line 2",
              "help": "Flat, floor or building; blank if none; blank keeps what is set",
              "kind": "text",
              "freeTextReason": "part of your address",
              "required": {
                "default": "",
                "defaultMeans": "keep what is set"
              },
              "typed": {
                "flag": "--line2"
              }
            },
            {
              "id": "city",
              "label": "City",
              "help": "Town or city; blank keeps what is set",
              "kind": "text",
              "freeTextReason": "part of your address",
              "required": {
                "default": "",
                "defaultMeans": "keep what is set"
              },
              "typed": {
                "flag": "--city"
              }
            },
            {
              "id": "region",
              "label": "State or region",
              "help": "Blank where there is none; blank keeps what is set",
              "kind": "text",
              "freeTextReason": "part of your address",
              "required": {
                "default": "",
                "defaultMeans": "keep what is set"
              },
              "typed": {
                "flag": "--region"
              }
            },
            {
              "id": "postalCode",
              "label": "Postal code",
              "help": "As the post office writes it; blank keeps what is set",
              "kind": "text",
              "freeTextReason": "part of your address",
              "required": {
                "default": "",
                "defaultMeans": "keep what is set"
              },
              "typed": {
                "flag": "--postal-code"
              }
            },
            {
              "id": "country",
              "label": "Country",
              "help": "Two letters, such as US or DE; blank keeps what is set",
              "kind": "text",
              "freeTextReason": "part of your address",
              "required": {
                "default": "",
                "defaultMeans": "keep what is set"
              },
              "typed": {
                "flag": "--country"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "permissions",
      "title": "Permissions",
      "summary": "See which permission settings are in force, and the rules that decide calls without asking",
      "group": "Permissions",
      "report": "show",
      "actions": [
        {
          "id": "show",
          "label": "See the permission settings in force",
          "word": "show",
          "line": "/permissions show",
          "sentence": "Shows the permission mode and settings in force, where each comes from, and how many rules there are.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "rules",
          "label": "See the permission rules",
          "word": "rules",
          "line": "/permissions rules",
          "sentence": "Lists every rule that decides a call without asking: what it covers, allow or deny, and where.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "never",
          "label": "Never run a command",
          "word": "never",
          "line": "/permissions never <command...>",
          "sentence": "Every tool is refused a command that runs \"{command}\", in every permission mode and every project, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "revoke",
          "operator": {
            "terminalOnly": "A rule is added from a terminal app; the web UI can list and remove them."
          },
          "inputs": [
            {
              "id": "command",
              "label": "Command",
              "help": "The command, as it starts (git push)",
              "kind": "text",
              "freeTextReason": "a command as you would type it",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "add",
          "label": "Add a permission rule",
          "word": "add",
          "line": "/permissions add <then> <for> <which...>",
          "sentence": "In this project, a call matching {kind} {target} will {effect} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "revoke",
          "operator": {
            "terminalOnly": "A rule for this project is added from the terminal app working in it."
          },
          "inputs": [
            {
              "id": "effect",
              "label": "Then",
              "help": "What happens to a matching call",
              "kind": "choice",
              "choices": [
                {
                  "value": "allow",
                  "label": "Run it without asking",
                  "risk": "loosens-a-protection"
                },
                {
                  "value": "ask",
                  "label": "Ask me"
                },
                {
                  "value": "deny",
                  "label": "Refuse it"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "kind",
              "label": "For",
              "help": "What the rule covers",
              "kind": "choice",
              "choices": [
                {
                  "value": "command",
                  "label": "This exact command"
                },
                {
                  "value": "class",
                  "label": "Every command starting with a word"
                },
                {
                  "value": "path",
                  "label": "Writing and editing under a folder"
                },
                {
                  "value": "tool",
                  "label": "Every call of a tool"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "target",
              "label": "Which",
              "help": "The command, word, folder or tool",
              "kind": "text",
              "freeTextReason": "a command, word, folder or tool name",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "revoke",
          "label": "Remove a permission rule",
          "word": "revoke",
          "line": "/permissions revoke <rule>",
          "sentence": "{rule} is removed, so a call it covered is decided as usual again (it may run, or be asked), until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "a rule may be what stops a command from running",
            "instead": "Ask the owner to remove it with /permissions revoke."
          },
          "operator": {
            "method": "permissions.rules.delete",
            "fields": {
              "ruleId": "rule"
            }
          },
          "inputs": [
            {
              "id": "rule",
              "label": "Rule",
              "help": "The rules in force",
              "kind": "choice",
              "choices": {
                "list": "permissions.rules"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "plugin",
      "title": "Plugins",
      "summary": "Switch plugins on and off, set what each one may do, and publish your own",
      "group": "Extensions",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See your plugins",
          "word": "list",
          "line": "/plugin list",
          "sentence": "Shows every plugin with its state and trust tier.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "enable",
          "label": "Switch a plugin on",
          "word": "enable",
          "line": "/plugin enable <plugin>",
          "sentence": "{plugin} starts now and at every start, under its trust tier, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "disable",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "disable",
          "label": "Switch a plugin off",
          "word": "disable",
          "line": "/plugin disable <plugin>",
          "sentence": "{plugin} stops now and does not start again, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "enable",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "reload",
          "label": "Load the plugins again",
          "word": "reload",
          "line": "/plugin reload",
          "sentence": "Every switched-on plugin is stopped and started again from its files.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": []
        },
        {
          "id": "quarantine",
          "label": "Quarantine a plugin",
          "word": "quarantine",
          "line": "/plugin quarantine <plugin> [<why...>]",
          "sentence": "{plugin} is stopped and blocked from loading until you change it (lift the quarantine).",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "lift",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "A note you will see when you look at it",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "quarantined by operator",
                "defaultMeans": "no note"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "lift",
          "label": "Lift a plugin's quarantine",
          "word": "lift",
          "line": "/plugin lift <plugin>",
          "sentence": "{plugin} may load again (after a reload), until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "it lets a quarantined plugin load again",
            "instead": "Ask the owner to lift it with /plugin lift."
          },
          "undoneBy": "quarantine",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "trust",
          "label": "Set what a plugin may do",
          "word": "trust",
          "line": "/plugin trust <plugin> <trust tier> [<note...>]",
          "sentence": "{plugin} is set to the {tier} tier on every app of this machine until you change it; a trusted tier without a valid signature is recorded in its trust note.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "tier",
              "label": "Trust tier",
              "help": "What it may register",
              "kind": "choice",
              "choices": [
                {
                  "value": "untrusted",
                  "label": "Untrusted",
                  "help": "panels, commands and reading files only; its tool, provider, event-hook, gateway-method, channel and delivery registrations are refused"
                },
                {
                  "value": "limited",
                  "label": "Limited",
                  "help": "the tools, providers and event hooks its manifest declares, plus gateway methods, channels and delivery strategies; high-risk capabilities stay withheld"
                },
                {
                  "value": "trusted",
                  "label": "Trusted",
                  "help": "everything its manifest declares, including shell, file-write and network capabilities",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "note",
              "label": "Note",
              "help": "Why you chose it",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "no note"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "trust-key",
          "label": "Save a plugin publisher's key",
          "word": "trust-key",
          "line": "/plugin trust-key <plugin> <key file>",
          "sentence": "The key in {key} is saved as {plugin}'s publisher key, until you change it, so its signature can be checked.",
          "done": "",
          "touches": "credential",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "key",
              "label": "Key file",
              "help": "The publisher's Ed25519 public key (.pem)",
              "kind": "path",
              "freeTextReason": "a file path on this machine",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "verify",
          "label": "Check a plugin's signature",
          "word": "verify",
          "line": "/plugin verify <plugin>",
          "sentence": "Checks {plugin}'s manifest signature against its publisher key.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "capabilities",
          "label": "See what a plugin asks to do",
          "word": "capabilities",
          "line": "/plugin capabilities <plugin>",
          "sentence": "Shows the capabilities {plugin} declares and which its tier grants or withholds.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "open",
          "label": "Open the plugins screen",
          "word": "open",
          "line": "/plugin open",
          "sentence": "Opens the full-screen view of your plugins.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "dirs",
          "label": "See where plugins are looked for",
          "word": "dirs",
          "line": "/plugin dirs",
          "sentence": "Shows the folders plugins are loaded from, and your own plugin folder.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "inspect",
          "label": "See one plugin",
          "word": "inspect",
          "line": "/plugin inspect <plugin>",
          "sentence": "Shows {plugin}'s version, state, tier, capabilities, signature and quarantine.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "review",
          "label": "See how much your plugins may do",
          "word": "review",
          "line": "/plugin review",
          "sentence": "Counts your plugins by state and trust tier.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "publish-local",
          "label": "Publish a plugin folder to the local catalog",
          "word": "publish-local",
          "line": "/plugin publish-local <catalog id> <plugin folder> <summary...>",
          "sentence": "The plugin in {path} is listed in the local curated catalog as {id} (\"{summary}\"), until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "unpublish",
          "operator": {
            "terminalOnly": "The curated catalog is on this machine."
          },
          "inputs": [
            {
              "id": "id",
              "label": "Catalog id",
              "help": "A short id you choose",
              "kind": "text",
              "freeTextReason": "a new id you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "path",
              "label": "Plugin folder",
              "help": "The folder with its manifest.json",
              "kind": "path",
              "freeTextReason": "a folder on this machine",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "summary",
              "label": "Summary",
              "help": "One line on what it does",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "unpublish",
          "label": "Take a plugin out of the local catalog",
          "word": "unpublish",
          "line": "/plugin unpublish <catalog entry>",
          "sentence": "{id} is removed from the local curated catalog; installs of it stay.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The curated catalog is on this machine."
          },
          "inputs": [
            {
              "id": "id",
              "label": "Catalog entry",
              "help": "Plugins in the local curated catalog",
              "kind": "choice",
              "choices": {
                "list": "plugin.catalog"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "plugin-trust",
      "title": "Plugins and their trust",
      "summary": "Switch plugins on and off, and set what each one may do",
      "group": "Extensions",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See your plugins",
          "word": "list",
          "line": "/plugin-trust list",
          "sentence": "Shows every plugin with its state and trust tier.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "enable",
          "label": "Switch a plugin on",
          "word": "enable",
          "line": "/plugin-trust enable <plugin>",
          "sentence": "{plugin} starts now and at every start, under its trust tier, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "disable",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "disable",
          "label": "Switch a plugin off",
          "word": "disable",
          "line": "/plugin-trust disable <plugin>",
          "sentence": "{plugin} stops now and does not start again, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "enable",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "reload",
          "label": "Load the plugins again",
          "word": "reload",
          "line": "/plugin-trust reload",
          "sentence": "Every switched-on plugin is stopped and started again from its files.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": []
        },
        {
          "id": "quarantine",
          "label": "Quarantine a plugin",
          "word": "quarantine",
          "line": "/plugin-trust quarantine <plugin> [<why...>]",
          "sentence": "{plugin} is stopped and blocked from loading until you change it (lift the quarantine).",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "lift",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "A note you will see when you look at it",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "quarantined by operator",
                "defaultMeans": "no note"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "lift",
          "label": "Lift a plugin's quarantine",
          "word": "lift",
          "line": "/plugin-trust lift <plugin>",
          "sentence": "{plugin} may load again (after a reload), until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "it lets a quarantined plugin load again",
            "instead": "Ask the owner to lift it with /plugin-trust lift."
          },
          "undoneBy": "quarantine",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "trust",
          "label": "Set what a plugin may do",
          "word": "trust",
          "line": "/plugin-trust trust <plugin> <trust tier> [<note...>]",
          "sentence": "{plugin} is set to the {tier} tier on every app of this machine until you change it; a trusted tier without a valid signature is recorded in its trust note.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "tier",
              "label": "Trust tier",
              "help": "What it may register",
              "kind": "choice",
              "choices": [
                {
                  "value": "untrusted",
                  "label": "Untrusted",
                  "help": "panels, commands and reading files only; its tool, provider, event-hook, gateway-method, channel and delivery registrations are refused"
                },
                {
                  "value": "limited",
                  "label": "Limited",
                  "help": "the tools, providers and event hooks its manifest declares, plus gateway methods, channels and delivery strategies; high-risk capabilities stay withheld"
                },
                {
                  "value": "trusted",
                  "label": "Trusted",
                  "help": "everything its manifest declares, including shell, file-write and network capabilities",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "note",
              "label": "Note",
              "help": "Why you chose it",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "no note"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "trust-key",
          "label": "Save a plugin publisher's key",
          "word": "trust-key",
          "line": "/plugin-trust trust-key <plugin> <key file>",
          "sentence": "The key in {key} is saved as {plugin}'s publisher key, until you change it, so its signature can be checked.",
          "done": "",
          "touches": "credential",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Plugins run inside each terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "key",
              "label": "Key file",
              "help": "The publisher's Ed25519 public key (.pem)",
              "kind": "path",
              "freeTextReason": "a file path on this machine",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "verify",
          "label": "Check a plugin's signature",
          "word": "verify",
          "line": "/plugin-trust verify <plugin>",
          "sentence": "Checks {plugin}'s manifest signature against its publisher key.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "capabilities",
          "label": "See what a plugin asks to do",
          "word": "capabilities",
          "line": "/plugin-trust capabilities <plugin>",
          "sentence": "Shows the capabilities {plugin} declares and which its tier grants or withholds.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "plugin",
              "label": "Plugin",
              "help": "Plugins found on this machine",
              "kind": "choice",
              "choices": {
                "list": "plugins"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "questions",
      "title": "What waits on you",
      "summary": "Permission asks, questions agents left, claims and purchase windows: see them and answer",
      "group": "Inbox",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See what waits on you",
          "word": "list",
          "line": "/questions list",
          "sentence": "Lists every open question, ask, claim and purchase window, with its answers.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "all",
          "label": "See everything ever asked of you",
          "word": "all",
          "line": "/questions all",
          "sentence": "Lists every inbox item, open or answered, newest first, with who answered and where the answer went.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "show",
          "label": "See one question in full",
          "word": "show",
          "line": "/questions show <item>",
          "sentence": "Shows {item} in full: who asked, when, the answers it takes, and where an answer went.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "item",
              "label": "Item",
              "help": "Everything in the inbox",
              "kind": "choice",
              "choices": {
                "list": "inbox.all"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "answer",
          "label": "Answer a question",
          "word": "answer",
          "line": "/questions answer <question> <answer...>",
          "sentence": "{item} is answered \"{answer}\" and the answer goes to whoever asked.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "ownerOnly": {
            "reason": "the owner's answer is the owner's",
            "instead": "Ask the owner to answer it with /questions answer."
          },
          "operator": {
            "terminalOnly": "The web UI answers the inbox on its own Inbox page."
          },
          "inputs": [
            {
              "id": "item",
              "label": "Question",
              "help": "What waits on you",
              "kind": "choice",
              "choices": {
                "list": "inbox.open",
                "allowOther": {
                  "reason": "the id of an item already answered"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "answer",
              "label": "Answer",
              "help": "One of its answers, then a note if you like; or your written answer",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        }
      ]
    },
    {
      "name": "remote",
      "title": "Remote runners",
      "summary": "Run work on self-hosted runners and review what they hand back",
      "group": "Work",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See remote runners at a glance",
          "word": "list",
          "line": "/remote list",
          "sentence": "Shows connections, runner contracts, pools, artifacts and supervisor sessions.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "open",
          "label": "Open the remote screen",
          "word": "open",
          "line": "/remote open",
          "sentence": "Opens the full-screen view of remote runners, pools and artifacts.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "show",
          "label": "See a remote connection",
          "word": "show",
          "line": "/remote show [<connection>]",
          "sentence": "Shows {connection}'s transport, errors, task, contract and tools.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "connection",
              "label": "Connection",
              "help": "Connections open now",
              "kind": "choice",
              "choices": {
                "list": "remote.connections"
              },
              "required": {
                "default": "",
                "defaultMeans": "the first one"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "contract",
          "label": "See a runner's contract",
          "word": "contract",
          "line": "/remote contract <runner>",
          "sentence": "Shows {runner}'s template, trust, transport, tools, write scope and review mode.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "runner",
              "label": "Runner",
              "help": "Runners this session knows",
              "kind": "choice",
              "choices": {
                "list": "remote.runners"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "supervisor",
          "label": "See a runner's supervisor session",
          "word": "supervisor",
          "line": "/remote supervisor [<runner>]",
          "sentence": "Shows {runner}'s transport, heartbeat, negotiated protocol, capabilities and recovery steps.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "runner",
              "label": "Runner",
              "help": "Runners connected over a transport",
              "kind": "choice",
              "choices": {
                "list": "remote.supervised"
              },
              "required": {
                "default": "",
                "defaultMeans": "the first one"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "capabilities",
          "label": "See what a runner can do",
          "word": "capabilities",
          "line": "/remote capabilities [<runner>]",
          "sentence": "Shows which capabilities {runner} supports and which it lacks.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "runner",
              "label": "Runner",
              "help": "Runners connected over a transport",
              "kind": "choice",
              "choices": {
                "list": "remote.supervised"
              },
              "required": {
                "default": "",
                "defaultMeans": "the first one"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "recover",
          "label": "See how to recover a runner",
          "word": "recover",
          "line": "/remote recover [<runner>]",
          "sentence": "Shows {runner}'s heartbeat and last error, and the steps that recover it.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "runner",
              "label": "Runner",
              "help": "Runners connected over a transport",
              "kind": "choice",
              "choices": {
                "list": "remote.supervised"
              },
              "required": {
                "default": "",
                "defaultMeans": "the first one that needs it"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "stop",
          "label": "Stop a remote runner",
          "word": "stop",
          "line": "/remote stop <connection>",
          "sentence": "The runner on {connection} is stopped; what it was doing is not finished.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
          },
          "inputs": [
            {
              "id": "connection",
              "label": "Connection",
              "help": "Connections open now",
              "kind": "choice",
              "choices": {
                "list": "remote.connections"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "dispatch",
          "label": "Start a remote runner on a task",
          "word": "dispatch",
          "line": "/remote dispatch [--template <kind of agent>] <task...>",
          "sentence": "A self-hosted runner starts on \"{task}\" now, with only its template's tools; it runs until it finishes or you stop it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "ownerOnly": {
            "reason": "it starts a runner with this machine's tools from your own words",
            "instead": "Ask the owner to type the /remote dispatch line."
          },
          "undoneBy": "stop",
          "operator": {
            "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
          },
          "inputs": [
            {
              "id": "task",
              "label": "Task",
              "help": "What the runner should do, in your own words",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "template",
              "label": "Kind of agent",
              "help": "Which agent template it follows",
              "kind": "choice",
              "choices": [
                {
                  "value": "orchestrator",
                  "label": "Orchestrator"
                },
                {
                  "value": "planner",
                  "label": "Planner"
                },
                {
                  "value": "engineer",
                  "label": "Engineer"
                },
                {
                  "value": "reviewer",
                  "label": "Reviewer"
                },
                {
                  "value": "tester",
                  "label": "Tester"
                },
                {
                  "value": "researcher",
                  "label": "Researcher"
                },
                {
                  "value": "integrator",
                  "label": "Integrator"
                },
                {
                  "value": "general",
                  "label": "General"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "a general agent"
              },
              "typed": {
                "flag": "--template"
              }
            }
          ]
        },
        {
          "id": "dispatch-pool",
          "label": "Start a runner from a pool on a task",
          "word": "dispatch-pool",
          "line": "/remote dispatch-pool <pool> [--template <kind of agent>] <task...>",
          "sentence": "A runner from pool {pool} starts on \"{task}\" now, with only its template's tools; it runs until it finishes or you stop it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "ownerOnly": {
            "reason": "it starts a runner with this machine's tools from your own words",
            "instead": "Ask the owner to type the /remote dispatch line."
          },
          "undoneBy": "stop",
          "operator": {
            "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
          },
          "inputs": [
            {
              "id": "pool",
              "label": "Pool",
              "help": "Your runner pools",
              "kind": "choice",
              "choices": {
                "list": "remote.pools"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "task",
              "label": "Task",
              "help": "What the runner should do, in your own words",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "template",
              "label": "Kind of agent",
              "help": "Which agent template it follows",
              "kind": "choice",
              "choices": [
                {
                  "value": "orchestrator",
                  "label": "Orchestrator"
                },
                {
                  "value": "planner",
                  "label": "Planner"
                },
                {
                  "value": "engineer",
                  "label": "Engineer"
                },
                {
                  "value": "reviewer",
                  "label": "Reviewer"
                },
                {
                  "value": "tester",
                  "label": "Tester"
                },
                {
                  "value": "researcher",
                  "label": "Researcher"
                },
                {
                  "value": "integrator",
                  "label": "Integrator"
                },
                {
                  "value": "general",
                  "label": "General"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "the pool's usual agent"
              },
              "typed": {
                "flag": "--template"
              }
            }
          ]
        },
        {
          "id": "pools",
          "label": "See runner pools",
          "word": "pools",
          "line": "/remote pools",
          "sentence": "Shows every runner pool with its runners, trust and template.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "pool",
          "label": "See a runner pool",
          "word": "pool",
          "line": "/remote pool <pool>",
          "sentence": "Shows {pool}'s label, trust, template, limit and runners.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "pool",
              "label": "Pool",
              "help": "Your runner pools",
              "kind": "choice",
              "choices": {
                "list": "remote.pools"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "create-pool",
          "label": "Make a runner pool",
          "word": "create-pool",
          "line": "/remote create-pool <pool id> [<label...>]",
          "sentence": "Runner pool {pool} is made, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
          },
          "inputs": [
            {
              "id": "pool",
              "label": "Pool id",
              "help": "A short id you choose",
              "kind": "text",
              "freeTextReason": "a new id you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "label",
              "label": "Label",
              "help": "A name people will read",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "the same as its id"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "assign",
          "label": "Put a runner in a pool",
          "word": "assign",
          "line": "/remote assign <pool> <runner>",
          "sentence": "Runner {runner} joins pool {pool} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "unassign",
          "operator": {
            "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
          },
          "inputs": [
            {
              "id": "pool",
              "label": "Pool",
              "help": "Your runner pools",
              "kind": "choice",
              "choices": {
                "list": "remote.pools"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "runner",
              "label": "Runner",
              "help": "Runners this session knows",
              "kind": "choice",
              "choices": {
                "list": "remote.runners"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "unassign",
          "label": "Take a runner out of a pool",
          "word": "unassign",
          "line": "/remote unassign <pool> <runner>",
          "sentence": "Runner {runner} leaves pool {pool} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "assign",
          "operator": {
            "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
          },
          "inputs": [
            {
              "id": "pool",
              "label": "Pool",
              "help": "Your runner pools",
              "kind": "choice",
              "choices": {
                "list": "remote.pools"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "runner",
              "label": "Runner",
              "help": "Runners in this pool",
              "kind": "choice",
              "choices": {
                "list": "remote.pool-runners",
                "dependsOn": "pool"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "artifacts",
          "label": "See what runners handed back",
          "word": "artifacts",
          "line": "/remote artifacts",
          "sentence": "Shows the review artifacts runners handed back, with their state and summary.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "review",
          "label": "Review an artifact",
          "word": "review",
          "line": "/remote review <artifact>",
          "sentence": "Shows what {artifact} holds: the task, its result and the evidence.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "artifact",
              "label": "Artifact",
              "help": "Work runners handed back for review",
              "kind": "choice",
              "choices": {
                "list": "remote.artifacts"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "export",
          "label": "Save a runner's work for review",
          "word": "export",
          "line": "/remote export <runner> [--to <file>]",
          "sentence": "What {runner} did is captured as an artifact and written to a file in this project.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": [
            {
              "id": "runner",
              "label": "Runner",
              "help": "Runners this session knows",
              "kind": "choice",
              "choices": {
                "list": "remote.runners"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "path",
              "label": "File",
              "help": "Where to write it",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": {
                "default": "",
                "defaultMeans": "the usual place in this project"
              },
              "typed": {
                "flag": "--to"
              }
            }
          ]
        },
        {
          "id": "artifact-export",
          "label": "Save an artifact to a file",
          "word": "artifact-export",
          "line": "/remote artifact-export <artifact> [--to <file>]",
          "sentence": "{artifact} is written to a file in this project.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": [
            {
              "id": "artifact",
              "label": "Artifact",
              "help": "Work runners handed back for review",
              "kind": "choice",
              "choices": {
                "list": "remote.artifacts"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "path",
              "label": "File",
              "help": "Where to write it",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": {
                "default": "",
                "defaultMeans": "the usual place in this project"
              },
              "typed": {
                "flag": "--to"
              }
            }
          ]
        },
        {
          "id": "rerun-local",
          "label": "Run an artifact's task here",
          "word": "rerun-local",
          "line": "/remote rerun-local <artifact>",
          "sentence": "A local agent starts in this project on the task {artifact} recorded, with only the tools it recorded (shown beside each artifact); it may come from another machine.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "it runs task text and a tool list that may come from another machine",
            "instead": "Ask the owner to type /remote rerun-local <artifact>."
          },
          "operator": {
            "terminalOnly": "The agent runs in this terminal app."
          },
          "inputs": [
            {
              "id": "artifact",
              "label": "Artifact",
              "help": "Work runners handed back for review",
              "kind": "choice",
              "choices": {
                "list": "remote.artifacts"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "import",
          "label": "Bring in an artifact from a file",
          "word": "import",
          "line": "/remote import <file>",
          "sentence": "The artifact in {path} is added for review, until you change it; a file that would replace a known runner's tools is refused.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is read from this project."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "An artifact file written by /remote export",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "setup",
          "label": "See how remote running is set up",
          "word": "setup",
          "line": "/remote setup",
          "sentence": "Shows the agent command a remote runner starts, whether the daemon and listener are on, and what to do next.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "setup-export",
          "label": "Save the remote setup to a file",
          "word": "setup-export",
          "line": "/remote setup-export <file>",
          "sentence": "The remote setup is written as JSON to {path}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "Where to write the setup file",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "env",
          "label": "See the environment a remote agent needs",
          "word": "env",
          "line": "/remote env",
          "sentence": "Shows the shell lines that point a remote agent at this session.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "env-export",
          "label": "Save the remote environment to a file",
          "word": "env-export",
          "line": "/remote env-export <file>",
          "sentence": "The shell lines a remote agent needs are written to {path}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "Where to write the shell snippet",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "tunnel",
          "label": "See how to tunnel remote traffic",
          "word": "tunnel",
          "line": "/remote tunnel",
          "sentence": "Shows how remote agent traffic reaches this session through a tunnel you run.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "tunnel-export",
          "label": "Save the tunnel guidance to a file",
          "word": "tunnel-export",
          "line": "/remote tunnel-export <file>",
          "sentence": "The tunnel guidance is written to {path}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "Where to write the guidance",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "bootstrap-export",
          "label": "Save a start-up bundle for another machine",
          "word": "bootstrap-export",
          "line": "/remote bootstrap-export <file>",
          "sentence": "A bundle with the agent command, environment and links another machine starts from is written to {path}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "Where to write the bundle",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "bootstrap-inspect",
          "label": "Look inside a start-up bundle",
          "word": "bootstrap-inspect",
          "line": "/remote bootstrap-inspect <file>",
          "sentence": "Shows the session, agent command and links in {path}.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A bundle written by /remote bootstrap-export",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "session-export",
          "label": "Save this session's runners to a bundle",
          "word": "session-export",
          "line": "/remote session-export <file>",
          "sentence": "This session's runner pools, runner contracts and artifacts are written to {path}; the conversation is not.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "Where to write the bundle",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "session-inspect",
          "label": "Look inside a session bundle",
          "word": "session-inspect",
          "line": "/remote session-inspect <file>",
          "sentence": "Shows what {path} holds and what bringing it in here would replace; nothing is changed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A bundle written by /remote session-export",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "session-import",
          "label": "Bring in a session bundle",
          "word": "session-import",
          "line": "/remote session-import <file>",
          "sentence": "The runner pools, contracts and artifacts in {path} are brought in, replacing any held here with the same ids.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The file is read from this project."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "A bundle written by /remote session-export",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "resume",
      "title": "Resume a session",
      "summary": "Continue a saved session here",
      "group": "Sessions",
      "actions": [
        {
          "id": "resume",
          "label": "Resume a saved session",
          "word": "",
          "line": "/resume <session> [--force]",
          "sentence": "This conversation is set aside and {session} continues here, with its messages, model and agent records.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.reopen",
            "fields": {
              "sessionId": "session"
            }
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "Your saved sessions, newest first",
              "kind": "choice",
              "choices": {
                "list": "sessions.saved",
                "allowOther": {
                  "reason": "a session id, the start of one, or its title"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "force",
              "label": "If it is open elsewhere",
              "help": "Another running terminal may have it open",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "Stop and say so"
                },
                {
                  "value": "yes",
                  "label": "Resume it here anyway",
                  "help": "That terminal's live state is forked."
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "stop and say so"
              },
              "typed": {
                "flag": "--force",
                "switchOn": "yes"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "save",
      "title": "Save this session",
      "summary": "Save this conversation under a name to come back to",
      "group": "Sessions",
      "actions": [
        {
          "id": "save",
          "label": "Save this session under a name",
          "word": "",
          "line": "/save [--switch] [--replace] [<name...>]",
          "sentence": "This conversation will be saved under the name given (or its title), until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "delete",
          "operator": {
            "terminalOnly": "The conversation is the terminal app's own."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A name you choose",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "the conversation's title"
              },
              "typed": {
                "tail": true
              }
            },
            {
              "id": "continue",
              "label": "Keep working in",
              "help": "This session, or the saved copy",
              "kind": "choice",
              "choices": [
                {
                  "value": "here",
                  "label": "This session"
                },
                {
                  "value": "copy",
                  "label": "The saved copy",
                  "help": "Later turns are saved under the new name."
                }
              ],
              "required": {
                "default": "here",
                "defaultMeans": "this session"
              },
              "typed": {
                "flag": "--switch",
                "switchOn": "copy"
              }
            },
            {
              "id": "replace",
              "label": "If the name is taken",
              "help": "Another saved conversation may have it",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "Stop and say so"
                },
                {
                  "value": "yes",
                  "label": "Replace it",
                  "help": "The conversation saved under that name now is lost.",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "stop and say so"
              },
              "typed": {
                "flag": "--replace",
                "switchOn": "yes"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "schedule",
      "title": "Schedules",
      "summary": "Run something at set times, with or without the app open",
      "group": "Automation",
      "report": "see-schedules",
      "actions": [
        {
          "id": "see-schedules",
          "label": "See your schedules",
          "word": "list",
          "line": "/schedule list",
          "sentence": "Shows each schedule: its name, when it runs, its next and last run, and what it does.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "automation.schedules.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "add",
          "label": "Schedule something to run",
          "word": "add",
          "line": "/schedule add [--when <describe it>] [--at <at>] [--every <every>] [--cron <pattern>] [--tz <time zone>] [--stagger <spread the start>] [--name <name>] [--target <where it runs>] [--model <model>] [--provider <provider>] [--deliver <answer goes to>] [--allow-unsafe-external-content] [--external-source <outside source>] [--reasoning <how hard it thinks>] [--thinking <thinking>] [--wake <when it wakes>] [--fallback <fallback models>] [--tool <tools it may use>]... [--template <template>] [--light-context] [--paused] <what it does...>",
          "sentence": "\"{prompt}\" will run at the times you gave, whether or not this app is open, until you change it.",
          "done": "Scheduled.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "remove",
          "operator": {
            "method": "automation.schedules.create",
            "fields": {
              "prompt": "prompt",
              "cron": "cron",
              "every": "every",
              "at": "at",
              "timezone": "tz",
              "name": "name",
              "model": "model",
              "provider": "provider",
              "template": "template",
              "reasoningEffort": "reasoning",
              "thinking": "thinking",
              "wakeMode": "wake",
              "fallbackModels": "fallback:lines",
              "toolAllowlist": "tool:lines",
              "externalContentSource": "source",
              "target.kind": "target"
            }
          },
          "inputs": [
            {
              "id": "prompt",
              "label": "What it does",
              "help": "Say it the way you would ask in the chat",
              "kind": "long-text",
              "freeTextReason": "your own words for what it does",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "how",
              "label": "When",
              "help": "How you say when it runs",
              "kind": "choice",
              "choices": [
                {
                  "value": "describe",
                  "label": "Describe it",
                  "help": "\"every weekday at 9am\"; read for you, and shown before it is kept"
                },
                {
                  "value": "at",
                  "label": "Once, at a date and time",
                  "help": "Such as 2026-12-01T09:00 (this machine's time zone when none is given)"
                },
                {
                  "value": "every",
                  "label": "Every so often",
                  "help": "Every 15m, 2h, 1d ..."
                },
                {
                  "value": "cron",
                  "label": "On a calendar pattern",
                  "help": "A cron expression, for people who know cron"
                }
              ],
              "required": {
                "default": "describe",
                "defaultMeans": "described in your words"
              },
              "typed": {
                "impliedBy": {
                  "input": "when",
                  "ifGiven": "describe",
                  "ifNot": "describe",
                  "orIfGiven": [
                    {
                      "input": "at",
                      "value": "at"
                    },
                    {
                      "input": "every",
                      "value": "every"
                    },
                    {
                      "input": "cron",
                      "value": "cron"
                    }
                  ]
                }
              }
            },
            {
              "id": "when",
              "label": "Describe it",
              "help": "In your words, such as every weekday at 9am",
              "kind": "text",
              "freeTextReason": "your own words for when",
              "required": true,
              "typed": {
                "flag": "--when"
              }
            },
            {
              "id": "at",
              "label": "At",
              "help": "A date and time such as 2026-12-01T09:00",
              "kind": "date-time",
              "required": true,
              "typed": {
                "flag": "--at"
              }
            },
            {
              "id": "every",
              "label": "Every",
              "help": "An interval such as 15m, 2h or 1d",
              "kind": "text",
              "freeTextReason": "an interval such as 15m",
              "required": true,
              "typed": {
                "flag": "--every"
              }
            },
            {
              "id": "cron",
              "label": "Pattern",
              "help": "Five cron fields, such as 0 9 * * 1-5",
              "kind": "text",
              "freeTextReason": "a cron expression",
              "required": true,
              "typed": {
                "flag": "--cron"
              }
            },
            {
              "id": "tz",
              "label": "Time zone",
              "help": "For a pattern or a description; blank for this machine's (America/Chicago)",
              "kind": "text",
              "freeTextReason": "a time zone such as Europe/Vienna",
              "required": {
                "default": "",
                "defaultMeans": "this machine's time zone (America/Chicago)"
              },
              "typed": {
                "flag": "--tz"
              }
            },
            {
              "id": "stagger",
              "label": "Spread the start",
              "help": "Start up to this long after the pattern's time, such as 5m, so many runs do not start at once",
              "kind": "text",
              "freeTextReason": "a duration such as 5m",
              "required": {
                "default": "",
                "defaultMeans": "start on time"
              },
              "typed": {
                "flag": "--stagger"
              }
            },
            {
              "id": "name",
              "label": "Name",
              "help": "What it is called in your list",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "the first words of what it does"
              },
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "target",
              "label": "Where it runs",
              "help": "Which conversation each run uses",
              "kind": "choice",
              "choices": [
                {
                  "value": "isolated",
                  "label": "A fresh conversation each time",
                  "help": "Nothing earlier is carried into a run."
                },
                {
                  "value": "main",
                  "label": "Your main conversation",
                  "help": "Each run continues the main session."
                },
                {
                  "value": "background",
                  "label": "In the background",
                  "help": "A background session of its own."
                },
                {
                  "value": "pinned",
                  "label": "The pinned conversation",
                  "help": "Runs in the session you pinned."
                }
              ],
              "required": {
                "default": "isolated",
                "defaultMeans": "a fresh conversation each time"
              },
              "typed": {
                "flag": "--target"
              }
            },
            {
              "id": "model",
              "label": "Model",
              "help": "The model a run uses",
              "kind": "text",
              "freeTextReason": "a model id such as gpt-5",
              "required": {
                "default": "",
                "defaultMeans": "the same as your chats"
              },
              "typed": {
                "flag": "--model"
              }
            },
            {
              "id": "provider",
              "label": "Provider",
              "help": "The provider of that model",
              "kind": "text",
              "freeTextReason": "a provider id",
              "required": {
                "default": "",
                "defaultMeans": "the model's usual provider"
              },
              "typed": {
                "flag": "--provider"
              }
            },
            {
              "id": "deliver",
              "label": "Answer goes to",
              "help": "A channel such as telegram or slack:C123",
              "kind": "text",
              "freeTextReason": "a channel as configuration writes it",
              "required": {
                "default": "",
                "defaultMeans": "your owner inbox"
              },
              "typed": {
                "flag": "--deliver"
              }
            },
            {
              "id": "outside",
              "label": "May act on content from outside sources",
              "help": "Mail, web pages and messages it reads may steer what it does",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "No",
                  "help": "Outside content is read as data, never as instructions."
                },
                {
                  "value": "yes",
                  "label": "Yes",
                  "help": "Outside content may steer the run.",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "no"
              },
              "typed": {
                "flag": "--allow-unsafe-external-content",
                "switchOn": "yes"
              }
            },
            {
              "id": "source",
              "label": "Outside source",
              "help": "The kind of outside content it reads, such as email or web",
              "kind": "text",
              "freeTextReason": "a source kind",
              "required": {
                "default": "",
                "defaultMeans": "none named"
              },
              "typed": {
                "flag": "--external-source"
              }
            },
            {
              "id": "reasoning",
              "label": "How hard it thinks",
              "help": "The reasoning effort a run uses",
              "kind": "choice",
              "choices": [
                {
                  "value": "none",
                  "label": "none"
                },
                {
                  "value": "instant",
                  "label": "instant"
                },
                {
                  "value": "minimal",
                  "label": "minimal"
                },
                {
                  "value": "low",
                  "label": "low"
                },
                {
                  "value": "medium",
                  "label": "medium"
                },
                {
                  "value": "high",
                  "label": "high"
                },
                {
                  "value": "xhigh",
                  "label": "xhigh"
                },
                {
                  "value": "max",
                  "label": "max"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "the model's usual"
              },
              "typed": {
                "flag": "--reasoning"
              }
            },
            {
              "id": "thinking",
              "label": "Thinking",
              "help": "The model's thinking mode",
              "kind": "text",
              "freeTextReason": "a thinking mode the model takes",
              "required": {
                "default": "",
                "defaultMeans": "the model's usual"
              },
              "typed": {
                "flag": "--thinking"
              }
            },
            {
              "id": "wake",
              "label": "When it wakes",
              "help": "Start at its time, or at the next heartbeat",
              "kind": "choice",
              "choices": [
                {
                  "value": "now",
                  "label": "At its time"
                },
                {
                  "value": "next-heartbeat",
                  "label": "At the next heartbeat"
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "at its time"
              },
              "typed": {
                "flag": "--wake"
              }
            },
            {
              "id": "fallback",
              "label": "Fallback models",
              "help": "Models to try when the first fails, separated by commas",
              "kind": "text",
              "freeTextReason": "model ids",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--fallback"
              }
            },
            {
              "id": "tool",
              "label": "Tools it may use",
              "help": "Only these tools; one per --tool",
              "kind": "text",
              "freeTextReason": "a tool name",
              "required": {
                "default": "",
                "defaultMeans": "every tool a run usually has"
              },
              "typed": {
                "flag": "--tool",
                "repeats": true
              }
            },
            {
              "id": "template",
              "label": "Template",
              "help": "A prompt template it starts from",
              "kind": "text",
              "freeTextReason": "a template name",
              "required": {
                "default": "",
                "defaultMeans": "none"
              },
              "typed": {
                "flag": "--template"
              }
            },
            {
              "id": "light",
              "label": "Light context",
              "help": "Start each run with less context, for speed",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "No"
                },
                {
                  "value": "yes",
                  "label": "Yes"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "no"
              },
              "typed": {
                "flag": "--light-context",
                "switchOn": "yes"
              }
            },
            {
              "id": "paused",
              "label": "Start paused",
              "help": "Kept, but runs only once you resume it",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "No"
                },
                {
                  "value": "yes",
                  "label": "Yes"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "no"
              },
              "typed": {
                "flag": "--paused",
                "switchOn": "yes"
              }
            }
          ]
        },
        {
          "id": "run-now",
          "label": "Run one now",
          "word": "run",
          "line": "/schedule run <schedule>",
          "sentence": "{schedule} will run once now; its usual times stay as they are.",
          "done": "Started {schedule}.",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "automation.schedules.run",
            "fields": {
              "scheduleId": "schedule"
            }
          },
          "inputs": [
            {
              "id": "schedule",
              "label": "Schedule",
              "help": "Your schedules",
              "kind": "choice",
              "choices": {
                "list": "schedules"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "pause",
          "label": "Pause one",
          "word": "pause",
          "line": "/schedule pause <schedule>",
          "sentence": "{schedule} will not run {lasts}; it is kept, and Resume one starts it again.",
          "done": "Paused {schedule}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "resume",
          "operator": {
            "method": "automation.schedules.pause",
            "fields": {
              "scheduleId": "schedule"
            }
          },
          "inputs": [
            {
              "id": "schedule",
              "label": "Schedule",
              "help": "Schedules that run now",
              "kind": "choice",
              "choices": {
                "list": "schedules.running"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "resume",
          "label": "Resume one",
          "word": "resume",
          "line": "/schedule resume <schedule>",
          "sentence": "{schedule} will run again at its next time, {lasts}.",
          "done": "Resumed {schedule}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "pause",
          "operator": {
            "method": "automation.schedules.resume",
            "fields": {
              "scheduleId": "schedule"
            }
          },
          "inputs": [
            {
              "id": "schedule",
              "label": "Schedule",
              "help": "Paused schedules",
              "kind": "choice",
              "choices": {
                "list": "schedules.paused"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "change",
          "label": "Change a schedule",
          "word": "change",
          "line": "/schedule change <schedule> [--when <describe it>] [--at <at>] [--every <every>] [--cron <pattern>] [--tz <time zone>] [--stagger <spread the start>] [--name <name>] [--task <or a task>] [--success-criteria <done when>] [<what it does...>]",
          "sentence": "{schedule} will run with what you changed, until you change it again.",
          "done": "Changed {schedule}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "automation.jobs.update",
            "fields": {
              "jobId": "schedule",
              "name": "name",
              "prompt": "prompt"
            }
          },
          "inputs": [
            {
              "id": "schedule",
              "label": "Schedule",
              "help": "Your schedules",
              "kind": "choice",
              "choices": {
                "list": "schedules"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "how",
              "label": "When",
              "help": "How you say when it runs",
              "kind": "choice",
              "choices": [
                {
                  "value": "describe",
                  "label": "Describe it",
                  "help": "\"every weekday at 9am\"; read for you, and shown before it is kept"
                },
                {
                  "value": "at",
                  "label": "Once, at a date and time",
                  "help": "Such as 2026-12-01T09:00 (this machine's time zone when none is given)"
                },
                {
                  "value": "every",
                  "label": "Every so often",
                  "help": "Every 15m, 2h, 1d ..."
                },
                {
                  "value": "cron",
                  "label": "On a calendar pattern",
                  "help": "A cron expression, for people who know cron"
                }
              ],
              "required": {
                "default": "describe",
                "defaultMeans": "keep its timing"
              },
              "typed": {
                "impliedBy": {
                  "input": "when",
                  "ifGiven": "describe",
                  "ifNot": "describe",
                  "orIfGiven": [
                    {
                      "input": "at",
                      "value": "at"
                    },
                    {
                      "input": "every",
                      "value": "every"
                    },
                    {
                      "input": "cron",
                      "value": "cron"
                    }
                  ]
                }
              }
            },
            {
              "id": "when",
              "label": "Describe it",
              "help": "In your words, such as every weekday at 9am",
              "kind": "text",
              "freeTextReason": "your own words for when",
              "required": {
                "default": "",
                "defaultMeans": "keep its timing"
              },
              "typed": {
                "flag": "--when"
              }
            },
            {
              "id": "at",
              "label": "At",
              "help": "A date and time such as 2026-12-01T09:00",
              "kind": "date-time",
              "required": {
                "default": "",
                "defaultMeans": "keep its timing"
              },
              "typed": {
                "flag": "--at"
              }
            },
            {
              "id": "every",
              "label": "Every",
              "help": "An interval such as 15m, 2h or 1d",
              "kind": "text",
              "freeTextReason": "an interval such as 15m",
              "required": {
                "default": "",
                "defaultMeans": "keep its timing"
              },
              "typed": {
                "flag": "--every"
              }
            },
            {
              "id": "cron",
              "label": "Pattern",
              "help": "Five cron fields, such as 0 9 * * 1-5",
              "kind": "text",
              "freeTextReason": "a cron expression",
              "required": {
                "default": "",
                "defaultMeans": "keep its timing"
              },
              "typed": {
                "flag": "--cron"
              }
            },
            {
              "id": "tz",
              "label": "Time zone",
              "help": "For a pattern or a description; blank for this machine's (America/Chicago)",
              "kind": "text",
              "freeTextReason": "a time zone such as Europe/Vienna",
              "required": {
                "default": "",
                "defaultMeans": "this machine's time zone (America/Chicago)"
              },
              "typed": {
                "flag": "--tz"
              }
            },
            {
              "id": "stagger",
              "label": "Spread the start",
              "help": "Start up to this long after the pattern's time, such as 5m, so many runs do not start at once",
              "kind": "text",
              "freeTextReason": "a duration such as 5m",
              "required": {
                "default": "",
                "defaultMeans": "start on time"
              },
              "typed": {
                "flag": "--stagger"
              }
            },
            {
              "id": "name",
              "label": "Name",
              "help": "A new name; blank keeps it",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "keep its name"
              },
              "typed": {
                "flag": "--name"
              }
            },
            {
              "id": "prompt",
              "label": "What it does",
              "help": "New words for what it does; blank keeps them",
              "kind": "long-text",
              "freeTextReason": "your own words for what it does",
              "required": {
                "default": "",
                "defaultMeans": "keep what it does"
              },
              "typed": {
                "tail": true
              }
            },
            {
              "id": "task",
              "label": "Or a task",
              "help": "Instead of plain words: the task, with the result that shows it is done below",
              "kind": "text",
              "freeTextReason": "your own words for the task",
              "required": {
                "default": "",
                "defaultMeans": "no task"
              },
              "typed": {
                "flag": "--task"
              }
            },
            {
              "id": "success",
              "label": "Done when",
              "help": "The result that shows the task is done",
              "kind": "text",
              "freeTextReason": "your own words for the result",
              "required": {
                "default": "",
                "defaultMeans": "no task"
              },
              "typed": {
                "flag": "--success-criteria"
              }
            }
          ]
        },
        {
          "id": "remove",
          "label": "Remove one",
          "word": "remove",
          "line": "/schedule remove <schedule>",
          "sentence": "{schedule} will stop running and be removed.",
          "done": "Removed {schedule}.",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "automation.schedules.delete",
            "fields": {
              "scheduleId": "schedule"
            }
          },
          "inputs": [
            {
              "id": "schedule",
              "label": "Schedule",
              "help": "Your schedules",
              "kind": "choice",
              "choices": {
                "list": "schedules"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "secrets",
      "title": "Secrets",
      "summary": "Keep passwords and keys where programs can read them, without showing them",
      "group": "Setup",
      "report": "see-secrets",
      "actions": [
        {
          "id": "see-secrets",
          "label": "See your secrets",
          "word": "list",
          "line": "/secrets list",
          "sentence": "Shows every stored secret by name, where it is kept and whether something overrides it; no value is shown.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": []
        },
        {
          "id": "set-secret",
          "label": "Store a secret",
          "word": "set",
          "line": "/secrets set <name> <value> [--scope <where to keep it>] [--storage <how to keep it>]",
          "sentence": "{key} will be kept in the {scope} secret store ({storage}) until you change it.",
          "done": "Stored {key} in the {scope} secret store ({storage}).",
          "touches": "credential",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "delete-secret",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Name",
              "help": "The name programs read it by, such as OPENAI_API_KEY",
              "kind": "choice",
              "choices": {
                "list": "secrets.stored",
                "allowOther": {
                  "reason": "a new name, such as OPENAI_API_KEY"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "value",
              "label": "Value",
              "help": "The password or key itself; hidden as you type",
              "kind": "secret",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Where to keep it",
              "help": "This project only, or every project",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Kept in this project's secret store, read only here."
                },
                {
                  "value": "user",
                  "label": "All your projects",
                  "help": "Kept in your own secret store, read in every project."
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project only"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "storage",
              "label": "How to keep it",
              "help": "Encrypted, or as plain text",
              "kind": "choice",
              "choices": [
                {
                  "value": "secure",
                  "label": "Encrypted",
                  "help": "Kept encrypted on this machine."
                },
                {
                  "value": "plaintext",
                  "label": "Plain text",
                  "help": "Kept readable by anything that can read the file.",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": {
                "default": "secure",
                "defaultMeans": "encrypted"
              },
              "typed": {
                "flag": "--storage"
              }
            }
          ]
        },
        {
          "id": "link-secret",
          "label": "Point a secret at a password manager",
          "word": "link",
          "line": "/secrets link <name> <reference> [--scope <where to keep it>] [--storage <how to keep it>]",
          "sentence": "{key} will be read from {reference}, kept in the {scope} secret store ({storage}), until you change it.",
          "done": "{key} now reads from {reference}.",
          "touches": "credential",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "delete-secret",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Name",
              "help": "The name programs read it by, such as OPENAI_API_KEY",
              "kind": "choice",
              "choices": {
                "list": "secrets.stored",
                "allowOther": {
                  "reason": "a new name, such as OPENAI_API_KEY"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "reference",
              "label": "Reference",
              "help": "A goodvibes://secrets/... address of a password manager entry or variable",
              "kind": "text",
              "freeTextReason": "the address of an entry in your password manager (see \"See where secrets can come from\")",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "scope",
              "label": "Where to keep it",
              "help": "This project only, or every project",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Kept in this project's secret store, read only here."
                },
                {
                  "value": "user",
                  "label": "All your projects",
                  "help": "Kept in your own secret store, read in every project."
                }
              ],
              "required": {
                "default": "project",
                "defaultMeans": "this project only"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "storage",
              "label": "How to keep it",
              "help": "Encrypted, or as plain text",
              "kind": "choice",
              "choices": [
                {
                  "value": "secure",
                  "label": "Encrypted",
                  "help": "Kept encrypted on this machine."
                },
                {
                  "value": "plaintext",
                  "label": "Plain text",
                  "help": "Kept readable by anything that can read the file.",
                  "risk": "loosens-a-protection"
                }
              ],
              "required": {
                "default": "secure",
                "defaultMeans": "encrypted"
              },
              "typed": {
                "flag": "--storage"
              }
            }
          ]
        },
        {
          "id": "check-secret",
          "label": "Check a secret is stored",
          "word": "get",
          "line": "/secrets get <secret>",
          "sentence": "Says whether {key} is stored and can be read; its value is not shown.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Secret",
              "help": "The secrets you have stored",
              "kind": "choice",
              "choices": {
                "list": "secrets.stored"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "test-reference",
          "label": "Test a secret reference",
          "word": "test",
          "line": "/secrets test <reference>",
          "sentence": "Reads {reference} once and says whether it gives a value; the value is not shown.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": [
            {
              "id": "reference",
              "label": "Reference",
              "help": "A goodvibes://secrets/... address of a password manager entry or variable",
              "kind": "text",
              "freeTextReason": "the address of an entry in your password manager (see \"See where secrets can come from\")",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "see-sources",
          "label": "See where secrets can come from",
          "word": "providers",
          "line": "/secrets providers",
          "sentence": "Lists the password managers and other places a secret can be read from, with a line for each.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": []
        },
        {
          "id": "see-storage",
          "label": "See how secrets are kept",
          "word": "storage",
          "line": "/secrets storage",
          "sentence": "Shows the storage rule, how many secrets are encrypted or plain text, and where each store is.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": []
        },
        {
          "id": "trust-secret",
          "label": "Use a secret from this project's store",
          "word": "trust",
          "line": "/secrets trust <secret>",
          "sentence": "{key} from this project's secret store will be used whenever you have not set it yourself, until you change it (a changed value asks again).",
          "done": "{key} from this project's secret store is used from now on.",
          "touches": "credential",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "a project's secret store is part of the checkout, so whoever wrote the repository may have put it there",
            "instead": "Ask the owner to choose \"Use a secret from this project's store\" in /secrets."
          },
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Secret",
              "help": "Secrets in this project's store that wait for you",
              "kind": "choice",
              "choices": {
                "list": "secrets.unconfirmed"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "delete-secret",
          "label": "Delete a secret",
          "word": "delete",
          "line": "/secrets delete <secret> [--scope <from>] [--storage <kept as>]",
          "sentence": "The stored value of {key} will be deleted; anything that reads it stops working until it is set again.",
          "done": "Deleted {key}.",
          "touches": "credential",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Secret",
              "help": "The secrets you have stored",
              "kind": "choice",
              "choices": {
                "list": "secrets.stored"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "scope",
              "label": "From",
              "help": "Which store to delete it from",
              "kind": "choice",
              "choices": [
                {
                  "value": "project",
                  "label": "This project",
                  "help": "Kept in this project's secret store, read only here."
                },
                {
                  "value": "user",
                  "label": "All your projects",
                  "help": "Kept in your own secret store, read in every project."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "every store that holds it"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "storage",
              "label": "Kept as",
              "help": "Only the encrypted or only the plain-text copy",
              "kind": "choice",
              "choices": [
                {
                  "value": "secure",
                  "label": "Encrypted",
                  "help": "Kept encrypted on this machine."
                },
                {
                  "value": "plaintext",
                  "label": "Plain text",
                  "help": "Kept readable by anything that can read the file."
                }
              ],
              "required": {
                "default": "",
                "defaultMeans": "both"
              },
              "typed": {
                "flag": "--storage"
              }
            }
          ]
        },
        {
          "id": "use-for-session",
          "label": "Use a secret for this session only",
          "word": "use",
          "line": "/secrets use <name> <value>",
          "sentence": "Programs this app runs will read the value as ${name}, for this session only; it is not stored.",
          "done": "${name} is set for this session only.",
          "touches": "credential",
          "lasts": "session",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is set in the terminal app's own session."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "The variable name programs read it by, such as GITHUB_TOKEN",
              "kind": "text",
              "freeTextReason": "a variable name you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "value",
              "label": "Value",
              "help": "The password or key itself; hidden as you type",
              "kind": "secret",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        }
      ]
    },
    {
      "name": "session",
      "title": "Sessions",
      "summary": "This conversation and your saved ones: resume, save, copy, export, branch and hand off work",
      "group": "Sessions",
      "report": "current",
      "actions": [
        {
          "id": "current",
          "label": "See this session",
          "word": "current",
          "line": "/session current",
          "sentence": "Shows this session's id, name, when it started, how many messages it has and its model.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is the terminal app's open session."
          },
          "inputs": []
        },
        {
          "id": "list",
          "label": "See your saved sessions",
          "word": "list",
          "line": "/session list",
          "sentence": "Lists your saved sessions, newest first, with what each was doing when it was left.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "resume",
          "label": "Resume a saved session",
          "word": "resume",
          "line": "/session resume <session> [--force]",
          "sentence": "This conversation is set aside and {session} continues here, with its messages, model and agent records.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.reopen",
            "fields": {
              "sessionId": "session"
            }
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "Your saved sessions, newest first",
              "kind": "choice",
              "choices": {
                "list": "sessions.saved",
                "allowOther": {
                  "reason": "a session id, the start of one, or its title"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "force",
              "label": "If it is open elsewhere",
              "help": "Another running terminal may have it open",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "Stop and say so"
                },
                {
                  "value": "yes",
                  "label": "Resume it here anyway",
                  "help": "That terminal's live state is forked."
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "stop and say so"
              },
              "typed": {
                "flag": "--force",
                "switchOn": "yes"
              }
            }
          ]
        },
        {
          "id": "save",
          "label": "Save this session under a name",
          "word": "save",
          "line": "/session save [--switch] [--replace] [<name...>]",
          "sentence": "This conversation will be saved under the name given (or its title), until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "delete",
          "operator": {
            "terminalOnly": "The conversation is the terminal app's own."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A name you choose",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "the conversation's title"
              },
              "typed": {
                "tail": true
              }
            },
            {
              "id": "continue",
              "label": "Keep working in",
              "help": "This session, or the saved copy",
              "kind": "choice",
              "choices": [
                {
                  "value": "here",
                  "label": "This session"
                },
                {
                  "value": "copy",
                  "label": "The saved copy",
                  "help": "Later turns are saved under the new name."
                }
              ],
              "required": {
                "default": "here",
                "defaultMeans": "this session"
              },
              "typed": {
                "flag": "--switch",
                "switchOn": "copy"
              }
            },
            {
              "id": "replace",
              "label": "If the name is taken",
              "help": "Another saved conversation may have it",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "Stop and say so"
                },
                {
                  "value": "yes",
                  "label": "Replace it",
                  "help": "The conversation saved under that name now is lost.",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "stop and say so"
              },
              "typed": {
                "flag": "--replace",
                "switchOn": "yes"
              }
            }
          ]
        },
        {
          "id": "fork",
          "label": "Continue in a copy of this session",
          "word": "fork",
          "line": "/session fork [<name...>]",
          "sentence": "A copy of this session is saved under the name given and later turns go to the copy; this session stays as it is now, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The conversation is the terminal app's own."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A name you choose",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "fork-of- and this session's id"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "rename",
          "label": "Rename this session",
          "word": "rename",
          "line": "/session rename <name...>",
          "sentence": "This session will be called {name} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The conversation is the terminal app's own."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "Its new name",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "info",
          "label": "See a saved session's details",
          "word": "info",
          "line": "/session info [<session>]",
          "sentence": "Shows a saved session: its title, model, provider, date, message count, file and what it was doing.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.get",
            "fields": {
              "sessionId": "session"
            }
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "Your saved sessions, newest first",
              "kind": "choice",
              "choices": {
                "list": "sessions.saved",
                "allowOther": {
                  "reason": "a session id, the start of one, or its title"
                }
              },
              "required": {
                "default": "",
                "defaultMeans": "this session"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "search",
          "label": "Search saved sessions",
          "word": "search",
          "line": "/session search <words...>",
          "sentence": "Finds saved sessions whose messages hold {words}, with the matching lines.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "sessions.search",
            "fields": {
              "query": "words"
            }
          },
          "inputs": [
            {
              "id": "words",
              "label": "Words",
              "help": "What to look for in their messages",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "delete",
          "label": "Delete a saved session",
          "word": "delete",
          "line": "/session delete <session>",
          "sentence": "Saved session {session} and its messages will be deleted from this project.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "sessions.delete",
            "fields": {
              "sessionId": "session"
            }
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "Your saved sessions, newest first",
              "kind": "choice",
              "choices": {
                "list": "sessions.saved",
                "allowOther": {
                  "reason": "a session id, the start of one, or its title"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "events",
          "label": "See this conversation's events",
          "word": "events",
          "line": "/session events [<kind>] [<from row>] [--last <how many>]",
          "sentence": "Shows the conversation's record entry by entry (messages, tool calls, approvals), newest page first.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is the terminal app's open conversation."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "Only one kind of entry",
              "kind": "choice",
              "choices": [
                {
                  "value": "all",
                  "label": "Everything"
                },
                {
                  "value": "user_input",
                  "label": "User input"
                },
                {
                  "value": "assistant_output",
                  "label": "Assistant output"
                },
                {
                  "value": "tool_call",
                  "label": "Tool call"
                },
                {
                  "value": "tool_result",
                  "label": "Tool result"
                },
                {
                  "value": "approval_request",
                  "label": "Approval request"
                },
                {
                  "value": "approval_resolution",
                  "label": "Approval resolution"
                },
                {
                  "value": "task_transition",
                  "label": "Task transition"
                },
                {
                  "value": "remote_status",
                  "label": "Remote status"
                },
                {
                  "value": "policy_warning",
                  "label": "Policy warning"
                },
                {
                  "value": "artifact_preview",
                  "label": "Artifact preview"
                },
                {
                  "value": "contract_state",
                  "label": "Contract state"
                },
                {
                  "value": "session_restore",
                  "label": "Session restore"
                },
                {
                  "value": "diagnostic_notice",
                  "label": "Diagnostic notice"
                },
                {
                  "value": "system_notice",
                  "label": "System notice"
                }
              ],
              "required": {
                "default": "all",
                "defaultMeans": "everything"
              },
              "typed": {
                "position": 1
              }
            },
            {
              "id": "start",
              "label": "From row",
              "help": "The first row to show",
              "kind": "number",
              "freeTextReason": "a row number from 1",
              "required": {
                "default": "",
                "defaultMeans": "the newest page"
              },
              "typed": {
                "position": 2
              }
            },
            {
              "id": "last",
              "label": "How many",
              "help": "How many rows to show",
              "kind": "number",
              "freeTextReason": "a whole number",
              "required": {
                "default": "",
                "defaultMeans": "one page"
              },
              "typed": {
                "flag": "--last"
              }
            }
          ]
        },
        {
          "id": "groups",
          "label": "See this conversation turn by turn",
          "word": "groups",
          "line": "/session groups [<kind>] [<from row>] [--last <how many>]",
          "sentence": "Shows the conversation's record grouped by turn, newest page first.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is the terminal app's open conversation."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "Only one kind of entry",
              "kind": "choice",
              "choices": [
                {
                  "value": "all",
                  "label": "Everything"
                },
                {
                  "value": "user_input",
                  "label": "User input"
                },
                {
                  "value": "assistant_output",
                  "label": "Assistant output"
                },
                {
                  "value": "tool_call",
                  "label": "Tool call"
                },
                {
                  "value": "tool_result",
                  "label": "Tool result"
                },
                {
                  "value": "approval_request",
                  "label": "Approval request"
                },
                {
                  "value": "approval_resolution",
                  "label": "Approval resolution"
                },
                {
                  "value": "task_transition",
                  "label": "Task transition"
                },
                {
                  "value": "remote_status",
                  "label": "Remote status"
                },
                {
                  "value": "policy_warning",
                  "label": "Policy warning"
                },
                {
                  "value": "artifact_preview",
                  "label": "Artifact preview"
                },
                {
                  "value": "contract_state",
                  "label": "Contract state"
                },
                {
                  "value": "session_restore",
                  "label": "Session restore"
                },
                {
                  "value": "diagnostic_notice",
                  "label": "Diagnostic notice"
                },
                {
                  "value": "system_notice",
                  "label": "System notice"
                }
              ],
              "required": {
                "default": "all",
                "defaultMeans": "everything"
              },
              "typed": {
                "position": 1
              }
            },
            {
              "id": "start",
              "label": "From row",
              "help": "The first row to show",
              "kind": "number",
              "freeTextReason": "a row number from 1",
              "required": {
                "default": "",
                "defaultMeans": "the newest page"
              },
              "typed": {
                "position": 2
              }
            },
            {
              "id": "last",
              "label": "How many",
              "help": "How many rows to show",
              "kind": "number",
              "freeTextReason": "a whole number",
              "required": {
                "default": "",
                "defaultMeans": "one page"
              },
              "typed": {
                "flag": "--last"
              }
            }
          ]
        },
        {
          "id": "hotspots",
          "label": "See where this conversation spent most",
          "word": "hotspots",
          "line": "/session hotspots [<kind>]",
          "sentence": "Counts the whole record by what took the most entries.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is the terminal app's open conversation."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Kind",
              "help": "Only one kind of entry",
              "kind": "choice",
              "choices": [
                {
                  "value": "all",
                  "label": "Everything"
                },
                {
                  "value": "user_input",
                  "label": "User input"
                },
                {
                  "value": "assistant_output",
                  "label": "Assistant output"
                },
                {
                  "value": "tool_call",
                  "label": "Tool call"
                },
                {
                  "value": "tool_result",
                  "label": "Tool result"
                },
                {
                  "value": "approval_request",
                  "label": "Approval request"
                },
                {
                  "value": "approval_resolution",
                  "label": "Approval resolution"
                },
                {
                  "value": "task_transition",
                  "label": "Task transition"
                },
                {
                  "value": "remote_status",
                  "label": "Remote status"
                },
                {
                  "value": "policy_warning",
                  "label": "Policy warning"
                },
                {
                  "value": "artifact_preview",
                  "label": "Artifact preview"
                },
                {
                  "value": "contract_state",
                  "label": "Contract state"
                },
                {
                  "value": "session_restore",
                  "label": "Session restore"
                },
                {
                  "value": "diagnostic_notice",
                  "label": "Diagnostic notice"
                },
                {
                  "value": "system_notice",
                  "label": "System notice"
                }
              ],
              "required": {
                "default": "all",
                "defaultMeans": "everything"
              },
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "save-file",
          "label": "Save this conversation as a file",
          "word": "save-file",
          "line": "/session save-file [<as>] [<file>] [--keep-secrets] [--replace] [--then <then>]",
          "sentence": "This conversation will be written to {path} as {format} on this machine, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The conversation is the terminal app's own."
          },
          "inputs": [
            {
              "id": "format",
              "label": "As",
              "help": "The kind of file",
              "kind": "choice",
              "choices": [
                {
                  "value": "markdown",
                  "label": "Markdown"
                },
                {
                  "value": "text",
                  "label": "Plain text"
                },
                {
                  "value": "html",
                  "label": "A web page",
                  "help": "Self-contained, with code highlighted"
                },
                {
                  "value": "json",
                  "label": "JSON",
                  "help": "For programs"
                }
              ],
              "required": {
                "default": "markdown",
                "defaultMeans": "Markdown"
              },
              "typed": {
                "position": 1
              }
            },
            {
              "id": "path",
              "label": "File",
              "help": "Where to write it",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": {
                "default": "",
                "defaultMeans": "a new file named for the time"
              },
              "typed": {
                "position": 2
              }
            },
            {
              "id": "redact",
              "label": "Keys and paths",
              "help": "API keys, tokens and your home path and login name",
              "kind": "choice",
              "choices": [
                {
                  "value": "hide",
                  "label": "Hide them"
                },
                {
                  "value": "keep",
                  "label": "Keep them as they are"
                }
              ],
              "required": {
                "default": "hide",
                "defaultMeans": "hide them"
              },
              "typed": {
                "flag": "--keep-secrets",
                "switchOn": "keep"
              }
            },
            {
              "id": "replace",
              "label": "If the file exists",
              "help": "Keep it, or write over it",
              "kind": "choice",
              "choices": [
                {
                  "value": "no",
                  "label": "Keep it and stop"
                },
                {
                  "value": "yes",
                  "label": "Write over it",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "no",
                "defaultMeans": "keep it and stop"
              },
              "typed": {
                "flag": "--replace",
                "switchOn": "yes"
              }
            },
            {
              "id": "open",
              "label": "Then",
              "help": "What to do with the file",
              "kind": "choice",
              "choices": [
                {
                  "value": "nothing",
                  "label": "Nothing more"
                },
                {
                  "value": "open",
                  "label": "Open it in the browser",
                  "help": "A web page only"
                },
                {
                  "value": "copy",
                  "label": "Copy its path"
                }
              ],
              "required": {
                "default": "nothing",
                "defaultMeans": "nothing more"
              },
              "typed": {
                "flag": "--then"
              }
            }
          ]
        },
        {
          "id": "save-saved",
          "label": "Save a saved session as a file",
          "word": "save-saved",
          "line": "/session save-saved <session> [<as>] [--print] [--out <file>]",
          "sentence": "The redacted transcript of {session} will be written out ({format}); an existing file is never replaced.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Saved sessions are files of the terminal app."
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "Your saved sessions; . is this one",
              "kind": "choice",
              "choices": {
                "list": "sessions.saved",
                "allowOther": {
                  "reason": "a session id, the start of one, or its title"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "format",
              "label": "As",
              "help": "The kind of text",
              "kind": "choice",
              "choices": [
                {
                  "value": "markdown",
                  "label": "Markdown"
                },
                {
                  "value": "text",
                  "label": "Plain text"
                }
              ],
              "required": {
                "default": "markdown",
                "defaultMeans": "Markdown"
              },
              "typed": {
                "position": 2
              }
            },
            {
              "id": "where",
              "label": "Where",
              "help": "A file, or this screen",
              "kind": "choice",
              "choices": [
                {
                  "value": "file",
                  "label": "Write it to a file"
                },
                {
                  "value": "here",
                  "label": "Print it here",
                  "help": "Shown only, never part of this conversation"
                }
              ],
              "required": {
                "default": "file",
                "defaultMeans": "a file"
              },
              "typed": {
                "flag": "--print",
                "switchOn": "here"
              }
            },
            {
              "id": "path",
              "label": "File",
              "help": "Where to write it",
              "kind": "path",
              "freeTextReason": "a file path",
              "required": {
                "default": "",
                "defaultMeans": "a new file in ~/goodvibes-exports"
              },
              "typed": {
                "flag": "--out"
              }
            }
          ]
        },
        {
          "id": "upload",
          "label": "Upload this conversation and get a link",
          "word": "upload",
          "line": "/session upload [<as>] [--keep-secrets] [--then <then>]",
          "sentence": "This conversation ({format}) will be written to a file and uploaded as a secret GitHub Gist that anyone with its link can read.",
          "done": "",
          "touches": "another-machine",
          "lasts": "not-a-change",
          "risk": "sends-out",
          "riskWords": "sends something outside this machine",
          "ownerOnly": {
            "reason": "it sends the conversation outside this machine",
            "instead": "Save it as a file instead: /session save-file"
          },
          "operator": {
            "terminalOnly": "The upload is made with the terminal app's GitHub sign-in."
          },
          "inputs": [
            {
              "id": "format",
              "label": "As",
              "help": "The kind of file",
              "kind": "choice",
              "choices": [
                {
                  "value": "html",
                  "label": "A web page"
                },
                {
                  "value": "md",
                  "label": "Markdown"
                },
                {
                  "value": "json",
                  "label": "JSON"
                }
              ],
              "required": {
                "default": "html",
                "defaultMeans": "a web page"
              },
              "typed": {
                "position": 1
              }
            },
            {
              "id": "redact",
              "label": "Keys and paths",
              "help": "API keys, tokens and your home path and login name",
              "kind": "choice",
              "choices": [
                {
                  "value": "hide",
                  "label": "Hide them"
                },
                {
                  "value": "keep",
                  "label": "Send them as stored",
                  "help": "Anyone with the link reads them, and copies cannot be recalled."
                }
              ],
              "required": {
                "default": "hide",
                "defaultMeans": "hide them"
              },
              "typed": {
                "flag": "--keep-secrets",
                "switchOn": "keep"
              }
            },
            {
              "id": "open",
              "label": "Then",
              "help": "What to do with the local copy",
              "kind": "choice",
              "choices": [
                {
                  "value": "nothing",
                  "label": "Nothing more"
                },
                {
                  "value": "open",
                  "label": "Open it in the browser"
                },
                {
                  "value": "copy",
                  "label": "Copy its path"
                }
              ],
              "required": {
                "default": "nothing",
                "defaultMeans": "nothing more"
              },
              "typed": {
                "flag": "--then"
              }
            }
          ]
        },
        {
          "id": "branch",
          "label": "Branch this conversation here",
          "word": "branch",
          "line": "/session branch [<name...>]",
          "sentence": "A branch is kept of the conversation as it is now, under the name given; you go on in the current one, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Branches belong to the conversation open in the terminal app."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A name for the branch",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "a numbered name"
              },
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "branches",
          "label": "See this conversation's branches",
          "word": "branches",
          "line": "/session branches",
          "sentence": "Lists the branches of this conversation and which one you are on.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Branches belong to the conversation open in the terminal app."
          },
          "inputs": []
        },
        {
          "id": "switch-branch",
          "label": "Switch to a branch",
          "word": "switch-branch",
          "line": "/session switch-branch <branch>",
          "sentence": "The conversation goes on from branch {branch} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Branches belong to the conversation open in the terminal app."
          },
          "inputs": [
            {
              "id": "branch",
              "label": "Branch",
              "help": "This conversation's branches",
              "kind": "choice",
              "choices": {
                "list": "sessions.branches"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "merge-branch",
          "label": "Bring a branch's new messages in",
          "word": "merge-branch",
          "line": "/session merge-branch <branch>",
          "sentence": "The messages branch {branch} gained after it was made are added to this conversation, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Branches belong to the conversation open in the terminal app."
          },
          "inputs": [
            {
              "id": "branch",
              "label": "Branch",
              "help": "This conversation's branches",
              "kind": "choice",
              "choices": {
                "list": "sessions.branches"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "graph",
          "label": "See the cross-session task graph",
          "word": "graph",
          "line": "/session graph [--session <session>] [--format <as>]",
          "sentence": "Shows the tasks linked across sessions, what each waits on, and the handoffs waiting.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The task graph is kept by the terminal app."
          },
          "inputs": [
            {
              "id": "session",
              "label": "Session",
              "help": "Only one session's tasks",
              "kind": "text",
              "freeTextReason": "a session id or its start",
              "required": {
                "default": "",
                "defaultMeans": "every session"
              },
              "typed": {
                "flag": "--session"
              }
            },
            {
              "id": "format",
              "label": "As",
              "help": "Text, or JSON for programs",
              "kind": "choice",
              "choices": [
                {
                  "value": "text",
                  "label": "Text"
                },
                {
                  "value": "json",
                  "label": "JSON"
                }
              ],
              "required": {
                "default": "text",
                "defaultMeans": "text"
              },
              "typed": {
                "flag": "--format"
              }
            }
          ]
        },
        {
          "id": "link-task",
          "label": "Add a task to the cross-session graph",
          "word": "link-task",
          "line": "/session link-task <task> [--session <in session>] [--depends-on <waits on>] [--label <label>]",
          "sentence": "Task {task} will be in the cross-session graph, with what it waits on, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The task graph is kept by the terminal app."
          },
          "inputs": [
            {
              "id": "task",
              "label": "Task",
              "help": "The task's id",
              "kind": "text",
              "freeTextReason": "a task id",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "from",
              "label": "In session",
              "help": "The session the task belongs to",
              "kind": "text",
              "freeTextReason": "a session id",
              "required": {
                "default": "",
                "defaultMeans": "this session"
              },
              "typed": {
                "flag": "--session"
              }
            },
            {
              "id": "after",
              "label": "Waits on",
              "help": "A task it depends on, as session:task or a task of the same session",
              "kind": "text",
              "freeTextReason": "a task reference",
              "required": {
                "default": "",
                "defaultMeans": "nothing"
              },
              "typed": {
                "flag": "--depends-on"
              }
            },
            {
              "id": "label",
              "label": "Label",
              "help": "A short name to show for it",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "its id"
              },
              "typed": {
                "flag": "--label"
              }
            }
          ]
        },
        {
          "id": "hand-off",
          "label": "Hand a task to another session",
          "word": "hand-off",
          "line": "/session hand-off <task> [--to <to session>] [--session <in session>] [--reason <why>]",
          "sentence": "Task {task} is offered to session {to} and waits until it is accepted or taken back.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "undoneBy": "withdraw",
          "operator": {
            "terminalOnly": "The task graph is kept by the terminal app."
          },
          "inputs": [
            {
              "id": "task",
              "label": "Task",
              "help": "The task's id",
              "kind": "text",
              "freeTextReason": "a task id",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "to",
              "label": "To session",
              "help": "The session that takes it",
              "kind": "text",
              "freeTextReason": "a session id",
              "required": true,
              "typed": {
                "flag": "--to"
              }
            },
            {
              "id": "from",
              "label": "In session",
              "help": "The session the task belongs to",
              "kind": "text",
              "freeTextReason": "a session id",
              "required": {
                "default": "",
                "defaultMeans": "this session"
              },
              "typed": {
                "flag": "--session"
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "A note the other session sees",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "no note"
              },
              "typed": {
                "flag": "--reason"
              }
            }
          ]
        },
        {
          "id": "accept",
          "label": "Accept a handoff",
          "word": "accept",
          "line": "/session accept <handoff>",
          "sentence": "Handoff {handoff} is accepted for its destination session and its task is no longer blocked.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The task graph is kept by the terminal app."
          },
          "inputs": [
            {
              "id": "handoff",
              "label": "Handoff",
              "help": "Handoffs waiting to be accepted",
              "kind": "choice",
              "choices": {
                "list": "sessions.handoffs.waiting"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "withdraw",
          "label": "Take back a handoff",
          "word": "withdraw",
          "line": "/session withdraw <handoff>",
          "sentence": "Handoff {handoff} is withdrawn and its task goes back to the status it had before.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The task graph is kept by the terminal app."
          },
          "inputs": [
            {
              "id": "handoff",
              "label": "Handoff",
              "help": "Handoffs waiting to be accepted",
              "kind": "choice",
              "choices": {
                "list": "sessions.handoffs.waiting"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "cancel",
          "label": "Cancel tasks in the graph",
          "word": "cancel",
          "line": "/session cancel <task> [--scope <what>] [--task <task>] [--session <in session>] [--reason <why>]",
          "sentence": "The tasks chosen ({scope}) will be cancelled; a cancelled task does not start again.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The task graph is kept by the terminal app."
          },
          "inputs": [
            {
              "id": "scope",
              "label": "What",
              "help": "One task, it and what waits on it, or every task of a session",
              "kind": "choice",
              "choices": [
                {
                  "value": "task",
                  "label": "Only this task"
                },
                {
                  "value": "subtree",
                  "label": "This task and everything waiting on it"
                },
                {
                  "value": "session",
                  "label": "Every task in the session"
                }
              ],
              "required": {
                "default": "task",
                "defaultMeans": "only this task"
              },
              "typed": {
                "flag": "--scope"
              }
            },
            {
              "id": "task",
              "label": "Task",
              "help": "The task's id",
              "kind": "text",
              "freeTextReason": "a task id",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "root",
              "label": "Task",
              "help": "The task whose waiting tasks go too",
              "kind": "text",
              "freeTextReason": "a task id",
              "required": true,
              "typed": {
                "flag": "--task"
              }
            },
            {
              "id": "from",
              "label": "In session",
              "help": "The session the task belongs to",
              "kind": "text",
              "freeTextReason": "a session id",
              "required": {
                "default": "",
                "defaultMeans": "this session"
              },
              "typed": {
                "flag": "--session"
              }
            },
            {
              "id": "reason",
              "label": "Why",
              "help": "A note kept with each cancelled task",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "no note"
              },
              "typed": {
                "flag": "--reason"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "settings-sync",
      "title": "Settings sync",
      "summary": "Carry your settings to another machine as a file, and settle values that disagree",
      "group": "Settings",
      "report": "review",
      "actions": [
        {
          "id": "review",
          "label": "See where your settings come from",
          "word": "review",
          "line": "/settings-sync review",
          "sentence": "Shows which layers your settings come from, sync state, conflicts, locks and recent failures.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "open",
          "label": "Open the settings sync screen",
          "word": "open",
          "line": "/settings-sync open",
          "sentence": "Opens the full-screen view of synced settings and conflicts.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "show",
          "label": "See where one setting's value comes from",
          "word": "show",
          "line": "/settings-sync show <setting>",
          "sentence": "Shows {key}'s value in each layer and which one wins.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Setting",
              "help": "A setting key, as /settings shows it",
              "kind": "text",
              "freeTextReason": "a setting key from /settings",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "conflicts",
          "label": "See settings that disagree",
          "word": "conflicts",
          "line": "/settings-sync conflicts",
          "sentence": "Shows the settings whose synced value differs from this machine's.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "resolve",
          "label": "Settle a setting that disagrees",
          "word": "resolve",
          "line": "/settings-sync resolve <setting> <keep>",
          "sentence": "{key} keeps the {keep} value until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Synced settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "key",
              "label": "Setting",
              "help": "Settings that disagree",
              "kind": "choice",
              "choices": {
                "list": "settings-sync.conflicts"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "keep",
              "label": "Keep",
              "help": "Which value wins",
              "kind": "choice",
              "choices": [
                {
                  "value": "local",
                  "label": "This machine's value"
                },
                {
                  "value": "synced",
                  "label": "The synced value"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "failures",
          "label": "See recent sync failures",
          "word": "failures",
          "line": "/settings-sync failures",
          "sentence": "Shows the sync and managed-setting attempts that failed recently and why.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "export",
          "label": "Save your settings to a sync bundle",
          "word": "export",
          "line": "/settings-sync export <bundle file>",
          "sentence": "Your settings are written to {path} as a bundle another machine can pull.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Synced settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "Where to write the bundle",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "inspect",
          "label": "Look inside a sync bundle",
          "word": "inspect",
          "line": "/settings-sync inspect <bundle file>",
          "sentence": "Shows what {path} holds; nothing is changed.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "A settings sync bundle (JSON)",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "pull",
          "label": "Take the settings from a sync bundle",
          "word": "pull",
          "line": "/settings-sync pull <bundle file>",
          "sentence": "The settings in {path} replace yours until you change it, except keys a managed lock owns; changes that touch security are shown and asked about first.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Synced settings are kept on this machine."
          },
          "inputs": [
            {
              "id": "path",
              "label": "Bundle file",
              "help": "A settings sync bundle (JSON)",
              "kind": "path",
              "freeTextReason": "a file path in this project",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "setup",
      "title": "Set up GoodVibes",
      "summary": "Choose a topic to set up: models, sign-in, keys, access, chat apps and features.",
      "group": "Settings",
      "actions": [
        {
          "id": "model",
          "label": "Choose a model",
          "word": "model",
          "line": "/setup model",
          "sentence": "Opens the form for the model new turns use and how hard it thinks.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "sign-in",
          "label": "Sign in or out of a provider",
          "word": "sign-in",
          "line": "/setup sign-in",
          "sentence": "Opens the form for signing in to a provider with your browser, finishing a sign-in, or signing out.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "add-provider",
          "label": "Add a provider of your own",
          "word": "add-provider",
          "line": "/setup add-provider <name> <address>",
          "sentence": "The provider {name} at {url} is added, until you remove it with /provider remove {name}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "A short name for the provider: letters, numbers, - and _",
              "kind": "text",
              "freeTextReason": "A name you choose.",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "url",
              "label": "Address",
              "help": "Its OpenAI-compatible address, ending in /v1",
              "kind": "text",
              "freeTextReason": "The address of a server you run or use.",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "store-key",
          "label": "Store a password or key",
          "word": "store-key",
          "line": "/setup store-key",
          "sentence": "Opens the form for storing a provider or channel key, and how keys are stored.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "local-only",
          "label": "Keep everything on this computer",
          "word": "local-only",
          "line": "/setup local-only",
          "sentence": "Opens the form that turns off the browser, network and webhook access.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "browser",
          "label": "Open GoodVibes in a browser",
          "word": "browser",
          "line": "/setup browser",
          "sentence": "Opens the form for using GoodVibes from a web browser on this computer or your network.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "other-devices",
          "label": "Use it from other devices",
          "word": "other-devices",
          "line": "/setup other-devices",
          "sentence": "Opens the form for letting your other devices reach GoodVibes: addresses and ports.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "webhooks",
          "label": "Receive webhooks",
          "word": "webhooks",
          "line": "/setup webhooks",
          "sentence": "Opens the form for receiving webhooks and events from other tools.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "chat-apps",
          "label": "Connect chat apps and services",
          "word": "chat-apps",
          "line": "/setup chat-apps",
          "sentence": "Opens the form for connecting Slack, Discord, Telegram and the other chat apps and services.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "cloudflare",
          "label": "Use Cloudflare",
          "word": "cloudflare",
          "line": "/setup cloudflare",
          "sentence": "Opens the form for using Cloudflare for batch and remote work.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "who-signs-in",
          "label": "Who can sign in here",
          "word": "who-signs-in",
          "line": "/setup who-signs-in",
          "sentence": "Opens the form for the account that signs in to this GoodVibes from other devices.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "how-it-works",
          "label": "How GoodVibes works with you",
          "word": "how-it-works",
          "line": "/setup how-it-works",
          "sentence": "Opens the form for how much GoodVibes tells you, how much guidance it gives, and when it asks.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "safety",
          "label": "Safety and sandboxing",
          "word": "safety",
          "line": "/setup safety",
          "sentence": "Opens the form for the sandbox and the other safety features.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "memory",
          "label": "Memory and context",
          "word": "memory",
          "line": "/setup memory",
          "sentence": "Opens the form for memory and how a long conversation is kept in context.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "telemetry",
          "label": "Telemetry",
          "word": "telemetry",
          "line": "/setup telemetry",
          "sentence": "Opens the form for tracing what GoodVibes does.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "automation",
          "label": "Automation",
          "word": "automation",
          "line": "/setup automation",
          "sentence": "Opens the form for scheduled routines, watchers and triggers.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "devices-voice",
          "label": "Paired devices and voice",
          "word": "devices-voice",
          "line": "/setup devices-voice",
          "sentence": "Opens the form for paired phones and voice.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "provider-behaviour",
          "label": "Provider behaviour",
          "word": "provider-behaviour",
          "line": "/setup provider-behaviour",
          "sentence": "Opens the form for how GoodVibes chooses and talks to providers.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "advanced",
          "label": "Advanced switches",
          "word": "advanced",
          "line": "/setup advanced",
          "sentence": "Opens the form for the advanced runtime switches.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "history",
          "label": "History and privacy",
          "word": "history",
          "line": "/setup history",
          "sentence": "Opens the setting for whether conversations are saved on this computer.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "import-settings",
          "label": "Bring over settings from the terminal app",
          "word": "import-settings",
          "line": "/setup import-settings",
          "sentence": "Copies the settings the Agent shares with the terminal app into the Agent.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "first-run",
          "label": "Run first-run again",
          "word": "first-run",
          "line": "/setup first-run",
          "sentence": "Opens the three-step first run: choose a provider, sign in, start.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "review",
          "label": "See what this setup has",
          "word": "review",
          "line": "/setup review",
          "sentence": "Shows the providers, services, plugins, hooks and servers this setup has.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "doctor",
          "label": "Check this setup for problems",
          "word": "doctor",
          "line": "/setup doctor",
          "sentence": "Checks this setup and lists what is not working.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "services",
          "label": "See the services and sign-ins",
          "word": "services",
          "line": "/setup services",
          "sentence": "Shows the configured services, provider sign-ins and their problems.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "hooks",
          "label": "See the hooks",
          "word": "hooks",
          "line": "/setup hooks",
          "sentence": "Shows how many hooks and hook chains this setup manages.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "remote",
          "label": "See the remote runners",
          "word": "remote",
          "line": "/setup remote",
          "sentence": "Shows the remote runners this setup can hand work to.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "sandbox",
          "label": "See the sandbox",
          "word": "sandbox",
          "line": "/setup sandbox",
          "sentence": "Shows how commands are contained on this computer.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "support-bundle",
          "label": "Save a support bundle",
          "word": "support-bundle",
          "line": "/setup support-bundle <folder> [--overwrite]",
          "sentence": "A support bundle about this setup is written to {dir}; credentials in it are masked.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "dir",
              "label": "Folder",
              "help": "The folder the support bundle is written to",
              "kind": "path",
              "freeTextReason": "A file or folder on this computer, typed as a path.",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "overwrite",
              "label": "If it is already there",
              "help": "What happens when something is already at that place",
              "kind": "choice",
              "choices": [
                {
                  "value": "keep",
                  "label": "Leave it and stop"
                },
                {
                  "value": "replace",
                  "label": "Replace it",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "keep",
                "defaultMeans": "leave it and stop"
              },
              "typed": {
                "flag": "--overwrite",
                "switchOn": "replace"
              }
            }
          ]
        },
        {
          "id": "support-bundle-inspect",
          "label": "Read a support bundle",
          "word": "support-bundle-inspect",
          "line": "/setup support-bundle-inspect <folder>",
          "sentence": "Shows what the support bundle in {dir} says about its setup.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "dir",
              "label": "Folder",
              "help": "The folder that holds the support bundle",
              "kind": "path",
              "freeTextReason": "A file or folder on this computer, typed as a path.",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "export",
          "label": "Save the setup review to a file",
          "word": "export",
          "line": "/setup export <file> [--overwrite]",
          "sentence": "The setup review is written as JSON to {path}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "The file the setup review is written to",
              "kind": "path",
              "freeTextReason": "A file or folder on this computer, typed as a path.",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "overwrite",
              "label": "If it is already there",
              "help": "What happens when something is already at that place",
              "kind": "choice",
              "choices": [
                {
                  "value": "keep",
                  "label": "Leave it and stop"
                },
                {
                  "value": "replace",
                  "label": "Replace it",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "keep",
                "defaultMeans": "leave it and stop"
              },
              "typed": {
                "flag": "--overwrite",
                "switchOn": "replace"
              }
            }
          ]
        },
        {
          "id": "transfer-export",
          "label": "Save this setup to move it",
          "word": "transfer-export",
          "line": "/setup transfer-export <file> [--overwrite]",
          "sentence": "Settings, services, plugins and skills are written to {path} for another computer; literal credentials are left out.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "The file the setup is written to",
              "kind": "path",
              "freeTextReason": "A file or folder on this computer, typed as a path.",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "overwrite",
              "label": "If it is already there",
              "help": "What happens when something is already at that place",
              "kind": "choice",
              "choices": [
                {
                  "value": "keep",
                  "label": "Leave it and stop"
                },
                {
                  "value": "replace",
                  "label": "Replace it",
                  "risk": "cannot-be-undone"
                }
              ],
              "required": {
                "default": "keep",
                "defaultMeans": "leave it and stop"
              },
              "typed": {
                "flag": "--overwrite",
                "switchOn": "replace"
              }
            }
          ]
        },
        {
          "id": "transfer-inspect",
          "label": "Read a moved setup",
          "word": "transfer-inspect",
          "line": "/setup transfer-inspect <file>",
          "sentence": "Shows what the setup file {path} holds.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "The setup file to read",
              "kind": "path",
              "freeTextReason": "A file or folder on this computer, typed as a path.",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "transfer-import",
          "label": "Bring in a moved setup",
          "word": "transfer-import",
          "line": "/setup transfer-import <file>",
          "sentence": "The settings and files in {path} replace the ones here, after you see the plan.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "path",
              "label": "File",
              "help": "The setup file to bring in",
              "kind": "path",
              "freeTextReason": "A file or folder on this computer, typed as a path.",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "link",
          "label": "Make a link to a view",
          "word": "link",
          "line": "/setup link <view> [<item>]",
          "sentence": "Shows a goodvibes:// link that opens {surface}.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "surface",
              "label": "View",
              "help": "The view the link opens",
              "kind": "choice",
              "choices": [
                {
                  "value": "cockpit",
                  "label": "cockpit"
                },
                {
                  "value": "security",
                  "label": "security"
                },
                {
                  "value": "remote",
                  "label": "remote"
                },
                {
                  "value": "knowledge",
                  "label": "knowledge"
                },
                {
                  "value": "marketplace",
                  "label": "marketplace"
                },
                {
                  "value": "sandbox",
                  "label": "sandbox"
                },
                {
                  "value": "incident",
                  "label": "incident"
                },
                {
                  "value": "hooks",
                  "label": "hooks"
                },
                {
                  "value": "orchestration",
                  "label": "orchestration"
                },
                {
                  "value": "tasks",
                  "label": "tasks"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "target",
              "label": "Item",
              "help": "One item in that view, by its id",
              "kind": "text",
              "freeTextReason": "An id inside the view, typed as it is shown there.",
              "required": {
                "default": "",
                "defaultMeans": "the view itself"
              },
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "open-link",
          "label": "Open a goodvibes:// link",
          "word": "open-link",
          "line": "/setup open-link <link>",
          "sentence": "Opens the view the link {uri} names.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "uri",
              "label": "Link",
              "help": "A goodvibes://open/… link",
              "kind": "text",
              "freeTextReason": "A link someone gave you, pasted as it is.",
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "skills",
      "title": "Skills",
      "summary": "See the skill packs the model can use, and publish your own",
      "group": "Extensions",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See your skills",
          "word": "list",
          "line": "/skills list",
          "sentence": "Lists every skill pack found, where it comes from, and what it is for.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "open",
          "label": "Open the skills screen",
          "word": "open",
          "line": "/skills open",
          "sentence": "Opens the full-screen view of your skills.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "show",
          "label": "See one skill",
          "word": "show",
          "line": "/skills show <skill>",
          "sentence": "Shows {skill}'s origin, path, description, dependencies and what it includes.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "skill",
              "label": "Skill",
              "help": "The skills found",
              "kind": "choice",
              "choices": {
                "list": "skills"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "origins",
          "label": "See where your skills come from",
          "word": "origins",
          "line": "/skills origins",
          "sentence": "Counts your skills by where they were found.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "publish-local",
          "label": "Publish a skill folder to the local catalog",
          "word": "publish-local",
          "line": "/skills publish-local <catalog id> <skill folder> <summary...>",
          "sentence": "The skill in {path} is listed in the local curated catalog as {id} (\"{summary}\"), until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "unpublish",
          "operator": {
            "terminalOnly": "The curated catalog is on this machine."
          },
          "inputs": [
            {
              "id": "id",
              "label": "Catalog id",
              "help": "A short id you choose",
              "kind": "text",
              "freeTextReason": "a new id you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "path",
              "label": "Skill folder",
              "help": "The folder with its SKILL.md",
              "kind": "path",
              "freeTextReason": "a folder on this machine",
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "summary",
              "label": "Summary",
              "help": "One line on what it does",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "unpublish",
          "label": "Take a skill out of the local catalog",
          "word": "unpublish",
          "line": "/skills unpublish <catalog entry>",
          "sentence": "{id} is removed from the local curated catalog; installs of it stay.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The curated catalog is on this machine."
          },
          "inputs": [
            {
              "id": "id",
              "label": "Catalog entry",
              "help": "Skills in the local curated catalog",
              "kind": "choice",
              "choices": {
                "list": "skills.catalog"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "todo",
      "title": "To-do list",
      "summary": "Keep this project's to-do list",
      "group": "Work",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See your to-do list",
          "word": "list",
          "line": "/todo list",
          "sentence": "Shows every item on the to-do list with its state.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "open",
          "label": "Open the to-do panel",
          "word": "open",
          "line": "/todo open",
          "sentence": "Opens the to-do list as a panel you can move through with the keys.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "markdown",
          "label": "See it as a Markdown checklist",
          "word": "markdown",
          "line": "/todo markdown",
          "sentence": "Shows the to-do list as a Markdown checklist.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "export",
          "label": "Save it as a Markdown file",
          "word": "export",
          "line": "/todo export",
          "sentence": "Writes the to-do list as a Markdown checklist into this project and says where.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "The file is written in this project."
          },
          "inputs": []
        },
        {
          "id": "add",
          "label": "Add an item",
          "word": "add",
          "line": "/todo add [--owner <for whom>] [--notes <notes>] [--source <where it came from>] <title...>",
          "sentence": "\"{title}\" is added to your to-do list until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "the to-do list is yours to change from the command line",
            "instead": "The model keeps its own plan with its work_plan tool."
          },
          "undoneBy": "remove",
          "operator": {
            "terminalOnly": "The to-do list is this project's, kept by the terminal app that has the project open."
          },
          "inputs": [
            {
              "id": "title",
              "label": "Title",
              "help": "What there is to do",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "owner",
              "label": "For whom",
              "help": "Who the item is for",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "nobody in particular"
              },
              "typed": {
                "flag": "--owner"
              }
            },
            {
              "id": "notes",
              "label": "Notes",
              "help": "Anything to remember about it",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "no notes"
              },
              "typed": {
                "flag": "--notes"
              }
            },
            {
              "id": "source",
              "label": "Where it came from",
              "help": "A short label for where the item came from",
              "kind": "text",
              "freeTextReason": "a label you choose",
              "required": {
                "default": "",
                "defaultMeans": "added by hand"
              },
              "typed": {
                "flag": "--source"
              }
            }
          ]
        },
        {
          "id": "edit",
          "label": "Change an item",
          "word": "edit",
          "line": "/todo edit <item> [--owner <for whom>] [--notes <notes>] [--source <where it came from>] <title...>",
          "sentence": "Item {item} becomes \"{title}\", with the other details you gave, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "the to-do list is yours to change from the command line",
            "instead": "The model keeps its own plan with its work_plan tool."
          },
          "operator": {
            "terminalOnly": "The to-do list is this project's, kept by the terminal app that has the project open."
          },
          "inputs": [
            {
              "id": "item",
              "label": "Item",
              "help": "The items on your to-do list",
              "kind": "choice",
              "choices": {
                "list": "todo.items"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "title",
              "label": "Title",
              "help": "What there is to do (change it or keep it)",
              "kind": "text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "owner",
              "label": "For whom",
              "help": "Who the item is for",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": {
                "default": "",
                "defaultMeans": "stays as it is"
              },
              "typed": {
                "flag": "--owner"
              }
            },
            {
              "id": "notes",
              "label": "Notes",
              "help": "Anything to remember about it",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "stay as they are"
              },
              "typed": {
                "flag": "--notes"
              }
            },
            {
              "id": "source",
              "label": "Where it came from",
              "help": "A short label for where the item came from",
              "kind": "text",
              "freeTextReason": "a label you choose",
              "required": {
                "default": "",
                "defaultMeans": "stays as it is"
              },
              "typed": {
                "flag": "--source"
              }
            }
          ]
        },
        {
          "id": "mark",
          "label": "Mark an item done, blocked or another state",
          "word": "mark",
          "line": "/todo mark <item> <state>",
          "sentence": "Item {item} is marked {state} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "the to-do list is yours to change from the command line",
            "instead": "The model keeps its own plan with its work_plan tool."
          },
          "operator": {
            "terminalOnly": "The to-do list is this project's, kept by the terminal app that has the project open."
          },
          "inputs": [
            {
              "id": "item",
              "label": "Item",
              "help": "The items on your to-do list",
              "kind": "choice",
              "choices": {
                "list": "todo.items"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "state",
              "label": "State",
              "help": "Where the item stands",
              "kind": "choice",
              "choices": [
                {
                  "value": "pending",
                  "label": "Not started"
                },
                {
                  "value": "in_progress",
                  "label": "In progress"
                },
                {
                  "value": "blocked",
                  "label": "Blocked"
                },
                {
                  "value": "done",
                  "label": "Done"
                },
                {
                  "value": "failed",
                  "label": "Failed"
                },
                {
                  "value": "cancelled",
                  "label": "Cancelled"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "next",
          "label": "Move an item to its next state",
          "word": "next",
          "line": "/todo next <item>",
          "sentence": "Item {item} moves on one state (not started, in progress, done, then back to not started) until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "ownerOnly": {
            "reason": "the to-do list is yours to change from the command line",
            "instead": "The model keeps its own plan with its work_plan tool."
          },
          "operator": {
            "terminalOnly": "The to-do list is this project's, kept by the terminal app that has the project open."
          },
          "inputs": [
            {
              "id": "item",
              "label": "Item",
              "help": "The items on your to-do list",
              "kind": "choice",
              "choices": {
                "list": "todo.items"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "remove",
          "label": "Remove an item",
          "word": "remove",
          "line": "/todo remove <item>",
          "sentence": "Item {item} is deleted from your to-do list.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "ownerOnly": {
            "reason": "the to-do list is yours to change from the command line",
            "instead": "The model keeps its own plan with its work_plan tool."
          },
          "operator": {
            "terminalOnly": "The to-do list is this project's, kept by the terminal app that has the project open."
          },
          "inputs": [
            {
              "id": "item",
              "label": "Item",
              "help": "The items on your to-do list",
              "kind": "choice",
              "choices": {
                "list": "todo.items"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "clear-done",
          "label": "Remove the finished items",
          "word": "clear-done",
          "line": "/todo clear-done",
          "sentence": "Every item that is done or cancelled is deleted from your to-do list.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "ownerOnly": {
            "reason": "the to-do list is yours to change from the command line",
            "instead": "The model keeps its own plan with its work_plan tool."
          },
          "operator": {
            "terminalOnly": "The to-do list is this project's, kept by the terminal app that has the project open."
          },
          "inputs": []
        }
      ]
    },
    {
      "name": "triggers",
      "title": "Triggers",
      "summary": "Act when something happens",
      "group": "Automation",
      "report": "see-triggers",
      "actions": [
        {
          "id": "see-triggers",
          "label": "See your triggers",
          "word": "list",
          "line": "/triggers list",
          "sentence": "Shows who supervises the triggers and each trigger: what it watches, its state and how often it fired.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "watchers.triggers.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "watch",
          "label": "Watch for something",
          "word": "watch",
          "line": "/triggers watch <name> [--definition <definition>] [--match <lines that match>] [--url <address>] [--file <file>] [--every <how often>] [--say <tell the agent>] [--deliver <answer goes to>] [--run <command to run>] [-- <command>...]",
          "sentence": "{name} will watch what you gave and act each time it fires, until you change it.",
          "done": "Watching: {name}.",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "stop",
          "operator": {
            "terminalOnly": "Watching for something is set up from a terminal app."
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "What it is called in your list",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "kind",
              "label": "Watch",
              "help": "What it watches",
              "kind": "choice",
              "choices": [
                {
                  "value": "finishes",
                  "label": "A command finishing",
                  "help": "Start a command and act when it ends, however it ends."
                },
                {
                  "value": "prints",
                  "label": "A line a command prints",
                  "help": "Keep a command running and act on each line that matches."
                },
                {
                  "value": "page",
                  "label": "A web address changing",
                  "help": "Fetch it every so often and act when it is different."
                },
                {
                  "value": "file",
                  "label": "A file changing",
                  "help": "Look at it every so often and act when it is different."
                },
                {
                  "value": "written",
                  "label": "Something else, written out",
                  "help": "A definition with any probe, rule or action the trigger family takes."
                }
              ],
              "required": {
                "default": "finishes",
                "defaultMeans": "a command finishing"
              },
              "typed": {
                "impliedBy": {
                  "input": "match",
                  "ifGiven": "prints",
                  "ifNot": "finishes",
                  "orIfGiven": [
                    {
                      "input": "url",
                      "value": "page"
                    },
                    {
                      "input": "path",
                      "value": "file"
                    },
                    {
                      "input": "definition",
                      "value": "written"
                    }
                  ]
                }
              }
            },
            {
              "id": "definition",
              "label": "Definition",
              "help": "JSON: { \"spec\": {...}, \"action\": {...} }, as the trigger family reads it",
              "kind": "long-text",
              "freeTextReason": "a probe, rule or action the choices above do not cover",
              "required": true,
              "typed": {
                "flag": "--definition"
              }
            },
            {
              "id": "command",
              "label": "Command",
              "help": "The program and its own arguments, as you would type them",
              "kind": "list",
              "freeTextReason": "the program and its arguments",
              "required": true,
              "typed": {
                "tail": true
              }
            },
            {
              "id": "match",
              "label": "Lines that match",
              "help": "A pattern, such as ERROR|FAILED",
              "kind": "text",
              "freeTextReason": "a pattern a line matches",
              "required": true,
              "typed": {
                "flag": "--match"
              }
            },
            {
              "id": "url",
              "label": "Address",
              "help": "The https:// page to fetch",
              "kind": "text",
              "freeTextReason": "the page's address",
              "required": true,
              "typed": {
                "flag": "--url"
              }
            },
            {
              "id": "path",
              "label": "File",
              "help": "The file to look at",
              "kind": "path",
              "freeTextReason": "a file on the daemon's machine",
              "required": true,
              "typed": {
                "flag": "--file"
              }
            },
            {
              "id": "every",
              "label": "How often",
              "help": "How often a page or file is looked at, such as 5m or 1h",
              "kind": "text",
              "freeTextReason": "an interval such as 5m",
              "required": {
                "default": "5m",
                "defaultMeans": "every 5 minutes"
              },
              "typed": {
                "flag": "--every"
              }
            },
            {
              "id": "then",
              "label": "Then",
              "help": "What happens when it fires",
              "kind": "choice",
              "choices": [
                {
                  "value": "ask",
                  "label": "Ask the agent to look at it",
                  "help": "A model turn reads what happened; its answer comes to you."
                },
                {
                  "value": "run",
                  "label": "Run a command you approved",
                  "help": "One of the commands you let triggers run."
                }
              ],
              "required": {
                "default": "ask",
                "defaultMeans": "ask the agent to look at it"
              },
              "typed": {
                "impliedBy": {
                  "input": "grant",
                  "ifGiven": "run",
                  "ifNot": "ask"
                }
              }
            },
            {
              "id": "say",
              "label": "Tell the agent",
              "help": "Your own instructions for the turn; blank for what happened only",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": {
                "default": "",
                "defaultMeans": "what happened, nothing more"
              },
              "typed": {
                "flag": "--say"
              }
            },
            {
              "id": "deliver",
              "label": "Answer goes to",
              "help": "A channel such as telegram or slack:C123",
              "kind": "text",
              "freeTextReason": "a channel as configuration writes it",
              "required": {
                "default": "",
                "defaultMeans": "your owner inbox"
              },
              "typed": {
                "flag": "--deliver"
              }
            },
            {
              "id": "grant",
              "label": "Command to run",
              "help": "Commands you let triggers run",
              "kind": "choice",
              "choices": {
                "list": "triggers.commands"
              },
              "required": true,
              "typed": {
                "flag": "--run"
              }
            }
          ]
        },
        {
          "id": "history",
          "label": "See what a trigger did",
          "word": "history",
          "line": "/triggers history <trigger> [--count <how many>]",
          "sentence": "Shows the newest runs of {trigger}: when, the outcome, and how a watched command ended.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "watchers.triggers.history",
            "fields": {
              "id": "trigger",
              "limit": "count:number"
            }
          },
          "inputs": [
            {
              "id": "trigger",
              "label": "Trigger",
              "help": "The triggers on the selected daemon",
              "kind": "choice",
              "choices": {
                "list": "triggers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "count",
              "label": "How many",
              "help": "The newest runs to show, 1 to 200",
              "kind": "number",
              "required": {
                "default": "20",
                "defaultMeans": "the newest 20"
              },
              "typed": {
                "flag": "--count"
              }
            }
          ]
        },
        {
          "id": "stop",
          "label": "Stop a trigger",
          "word": "stop",
          "line": "/triggers stop <trigger>",
          "sentence": "{trigger} will stop watching, and a command it started is stopped.",
          "done": "Stopped {trigger}.",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "watchers.triggers.cancel",
            "fields": {
              "id": "trigger"
            }
          },
          "inputs": [
            {
              "id": "trigger",
              "label": "Trigger",
              "help": "The triggers on the selected daemon",
              "kind": "choice",
              "choices": {
                "list": "triggers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "restart",
          "label": "Start a trigger that gave up",
          "word": "restart",
          "line": "/triggers restart <trigger>",
          "sentence": "{trigger}, which stopped after repeated failures, will watch again {lasts}; fix what made it fail first.",
          "done": "Started {trigger} again.",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "watchers.triggers.reset",
            "fields": {
              "id": "trigger"
            }
          },
          "inputs": [
            {
              "id": "trigger",
              "label": "Trigger",
              "help": "Triggers that stopped after failing again and again",
              "kind": "choice",
              "choices": {
                "list": "triggers"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "see-commands",
          "label": "See commands triggers may run",
          "word": "commands",
          "line": "/triggers commands",
          "sentence": "Shows each command you let triggers run, with the digest a trigger names.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "watchers.triggers.grant.list",
            "fields": {}
          },
          "inputs": []
        },
        {
          "id": "allow-command",
          "label": "Let triggers run a command",
          "word": "allow-command",
          "line": "/triggers allow-command <name> [-- <command>...]",
          "sentence": "A trigger may run {command} as {name} when it fires, with nobody asked, until you change it.",
          "done": "Triggers may run {name}.",
          "touches": "another-machine",
          "lasts": "kept",
          "risk": "loosens-a-protection",
          "riskWords": "loosens a protection",
          "ownerOnly": {
            "reason": "it lets a trigger run a command with nobody asked",
            "instead": "Ask the owner to choose \"Let triggers run a command\" in /triggers."
          },
          "operator": {
            "method": "watchers.triggers.grant.register",
            "fields": {
              "id": "name",
              "command": "command:first",
              "args": "command:rest",
              "description": "name"
            }
          },
          "inputs": [
            {
              "id": "name",
              "label": "Name",
              "help": "What a trigger calls it",
              "kind": "text",
              "freeTextReason": "a name you choose",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "command",
              "label": "Command",
              "help": "The program and its own arguments, run exactly so",
              "kind": "list",
              "freeTextReason": "the program and its arguments",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        }
      ]
    },
    {
      "name": "verbosity",
      "title": "How much the app prints",
      "summary": "Set how much the app prints: quiet, balanced or operator",
      "group": "Display",
      "report": "show",
      "actions": [
        {
          "id": "show",
          "label": "See how much the app prints",
          "word": "show",
          "line": "/verbosity show",
          "sentence": "Shows the print level, what it does, and any kind of notification set on its own.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "set",
          "label": "Set how much the app prints",
          "word": "set",
          "line": "/verbosity set <print level>",
          "sentence": "The app prints at the {level} level until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is how this terminal app prints."
          },
          "inputs": [
            {
              "id": "level",
              "label": "Print level",
              "help": "How much reaches you as it happens",
              "kind": "choice",
              "choices": [
                {
                  "value": "quiet",
                  "label": "Quiet",
                  "help": "Only warnings and errors pop up; the rest waits in /notifications."
                },
                {
                  "value": "balanced",
                  "label": "Balanced",
                  "help": "Notices pop up; routine notifications wait in /notifications (the usual)."
                },
                {
                  "value": "operator",
                  "label": "Operator",
                  "help": "Every notice and notification pops up."
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "set-domain",
          "label": "Set one kind of notification's level",
          "word": "set-domain",
          "line": "/verbosity set-domain <kind of notification> <how much of it>",
          "sentence": "Notifications of {domain} are shown at {verbosity} for this session only.",
          "done": "",
          "touches": "this-machine",
          "lasts": "session",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is how this terminal app prints."
          },
          "inputs": [
            {
              "id": "domain",
              "label": "Kind of notification",
              "help": "A notification domain, as /notifications shows it",
              "kind": "text",
              "freeTextReason": "a domain name from /notifications",
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "verbosity",
              "label": "How much of it",
              "help": "How much of this kind reaches you",
              "kind": "choice",
              "choices": [
                {
                  "value": "minimal",
                  "label": "Minimal"
                },
                {
                  "value": "normal",
                  "label": "Normal"
                },
                {
                  "value": "verbose",
                  "label": "Verbose"
                }
              ],
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        }
      ]
    },
    {
      "name": "workstream",
      "title": "Workstreams",
      "summary": "Plan, start, follow and steer work that runs in steps",
      "group": "Work",
      "report": "list",
      "actions": [
        {
          "id": "list",
          "label": "See your workstreams",
          "word": "list",
          "line": "/workstream list",
          "sentence": "Shows every workstream of this session with its state.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "status",
          "label": "See how a workstream is going",
          "word": "status",
          "line": "/workstream status <workstream>",
          "sentence": "Shows {workstream}'s steps, their state, its spending limit and any question it is waiting on.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "workstream",
              "label": "Workstream",
              "help": "The workstreams of this session",
              "kind": "choice",
              "choices": {
                "list": "workstreams"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "start",
          "label": "Start work on a request",
          "word": "start",
          "line": "/workstream start <request...>",
          "sentence": "Starts a workstream for \"{request}\" now; it runs in steps until it finishes or you stop it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "undoneBy": "stop",
          "operator": {
            "terminalOnly": "A request starts from the terminal session that runs it."
          },
          "inputs": [
            {
              "id": "request",
              "label": "Request",
              "help": "What to do, the way you would ask in the chat",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "stop",
          "label": "Stop a workstream",
          "word": "stop",
          "line": "/workstream stop <workstream>",
          "sentence": "{workstream} will stop; steps that are running are cancelled and it cannot be resumed.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "workstream",
              "label": "Workstream",
              "help": "The workstreams of this session",
              "kind": "choice",
              "choices": {
                "list": "workstreams"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "answer",
          "label": "Answer a workstream's question",
          "word": "answer",
          "line": "/workstream answer <workstream> <question> <answer...>",
          "sentence": "{workstream} gets your answer to {question}: \"{answer}\". It goes on from there until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "method": "contracts.reply",
            "fields": {
              "id": "workstream",
              "escalationId": "question",
              "text": "answer"
            }
          },
          "inputs": [
            {
              "id": "workstream",
              "label": "Workstream",
              "help": "The workstreams of this session",
              "kind": "choice",
              "choices": {
                "list": "workstreams"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "question",
              "label": "Question",
              "help": "The questions it is waiting on",
              "kind": "choice",
              "choices": {
                "list": "workstreams.questions",
                "dependsOn": "workstream"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "answer",
              "label": "Answer",
              "help": "Your answer, in your own words (retry or cancel for a failed step)",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "retry",
          "label": "Run a step of a workstream again",
          "word": "retry",
          "line": "/workstream retry <workstream> <step>",
          "sentence": "Step {step} of {workstream} runs again now.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "contracts.retryUnit",
            "fields": {
              "id": "workstream",
              "unitId": "step"
            }
          },
          "inputs": [
            {
              "id": "workstream",
              "label": "Workstream",
              "help": "The workstreams of this session",
              "kind": "choice",
              "choices": {
                "list": "workstreams"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "step",
              "label": "Step",
              "help": "The steps of this workstream",
              "kind": "choice",
              "choices": {
                "list": "workstreams.steps",
                "dependsOn": "workstream"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "budget",
          "label": "Change a workstream's spending limit",
          "word": "budget",
          "line": "/workstream budget <workstream> <most it may spend>",
          "sentence": "{workstream} may spend up to ${dollars} in all, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "spends-money",
          "riskWords": "spends money",
          "operator": {
            "method": "contracts.budget",
            "fields": {
              "id": "workstream",
              "maxCostUsd": "dollars"
            }
          },
          "inputs": [
            {
              "id": "workstream",
              "label": "Workstream",
              "help": "The workstreams of this session",
              "kind": "choice",
              "choices": {
                "list": "workstreams"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "dollars",
              "label": "Most it may spend",
              "help": "In US dollars, for the whole workstream",
              "kind": "money",
              "freeTextReason": "an amount",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "plan",
          "label": "Plan work before it runs",
          "word": "plan",
          "line": "/workstream plan <goal...>",
          "sentence": "A plan for \"{goal}\" is made and kept until you change it; nothing runs until you approve and launch it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "undoneBy": "discard",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "goal",
              "label": "Goal",
              "help": "What the work should achieve, in your own words",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "plans",
          "label": "See your plans",
          "word": "plans",
          "line": "/workstream plans",
          "sentence": "Shows every plan, whether it is approved, and how many steps it has.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "show",
          "label": "See a plan",
          "word": "show",
          "line": "/workstream show <plan>",
          "sentence": "Shows {plan}'s steps and how it was split.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "replan",
          "label": "Plan again from a new goal",
          "word": "replan",
          "line": "/workstream replan <plan> <new goal...>",
          "sentence": "{plan} is planned again from \"{goal}\", replacing its steps, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "goal",
              "label": "New goal",
              "help": "What the work should achieve, in your own words",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "edit-step",
          "label": "Change a step of a plan",
          "word": "edit",
          "line": "/workstream edit <plan> <step> <what the step does...>",
          "sentence": "Step {step} of {plan} will do \"{brief}\", until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "step",
              "label": "Step",
              "help": "The steps of this plan",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plan-steps",
                "dependsOn": "plan"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "brief",
              "label": "What the step does",
              "help": "The step's new brief",
              "kind": "long-text",
              "freeTextReason": "your own words",
              "required": true,
              "typed": {
                "tail": true
              }
            }
          ]
        },
        {
          "id": "drop-step",
          "label": "Take a step out of a plan",
          "word": "drop",
          "line": "/workstream drop <plan> <step>",
          "sentence": "Step {step} is taken out of {plan}, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "step",
              "label": "Step",
              "help": "The steps of this plan",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plan-steps",
                "dependsOn": "plan"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "move-step",
          "label": "Move a step of a plan",
          "word": "move",
          "line": "/workstream move <plan> <step> [--to <new position>]",
          "sentence": "Step {step} of {plan} moves to position {position}, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "step",
              "label": "Step",
              "help": "The steps of this plan",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plan-steps",
                "dependsOn": "plan"
              },
              "required": true,
              "typed": {
                "position": 2
              }
            },
            {
              "id": "position",
              "label": "New position",
              "help": "Its place in the plan, counting from 1",
              "kind": "number",
              "freeTextReason": "a position number",
              "required": true,
              "typed": {
                "flag": "--to"
              }
            }
          ]
        },
        {
          "id": "approve",
          "label": "Approve a plan",
          "word": "approve",
          "line": "/workstream approve <plan>",
          "sentence": "{plan} is marked approved, ready to launch, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "launch",
          "label": "Launch an approved plan",
          "word": "launch",
          "line": "/workstream launch <plan>",
          "sentence": "{plan} starts now as a workstream; it runs in steps until it finishes or you stop it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "undoneBy": "stop",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "discard",
          "label": "Throw a plan away",
          "word": "discard",
          "line": "/workstream discard <plan>",
          "sentence": "{plan} and its steps are deleted.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "Workstreams belong to the terminal session that runs them."
          },
          "inputs": [
            {
              "id": "plan",
              "label": "Plan",
              "help": "The plans you have made",
              "kind": "choice",
              "choices": {
                "list": "workstreams.plans"
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    },
    {
      "name": "worktree",
      "title": "Worktrees",
      "summary": "See and look after the git worktrees parallel work runs in",
      "group": "Work",
      "report": "review",
      "actions": [
        {
          "id": "review",
          "label": "See your worktrees",
          "word": "review",
          "line": "/worktree review",
          "sentence": "Shows every worktree with its state, branch, age, size and why it is kept.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": []
        },
        {
          "id": "open",
          "label": "Open the worktrees in Agents",
          "word": "open",
          "line": "/worktree open",
          "sentence": "Opens Agents on the worktree list.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "It is a terminal screen."
          },
          "inputs": []
        },
        {
          "id": "inspect",
          "label": "See one worktree",
          "word": "inspect",
          "line": "/worktree inspect <worktree>",
          "sentence": "Shows {worktree}'s state, owner, session, task, setup and what to do next.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "setup",
          "label": "Run a worktree's setup again",
          "word": "setup",
          "line": "/worktree setup <worktree>",
          "sentence": "The cold-start setup (worktree.setup.commands and carried-over files) runs again in {worktree}.",
          "done": "",
          "touches": "this-machine",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "method": "worktrees.setup.run",
            "fields": {
              "path": "worktree"
            }
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "attach",
          "label": "Tie a worktree to a session or task",
          "word": "attach",
          "line": "/worktree attach <worktree> <its id> [--to <attached to>]",
          "sentence": "{worktree} is tied to {kind} {id} until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The worktree list is read from this project."
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "kind",
              "label": "Attached to",
              "help": "A session or a task",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "A session"
                },
                {
                  "value": "task",
                  "label": "A task"
                }
              ],
              "required": true,
              "typed": {
                "flag": "--to"
              }
            },
            {
              "id": "id",
              "label": "Its id",
              "help": "The session's or task's id",
              "kind": "text",
              "freeTextReason": "an id from /sessions or /tasks",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "attached",
          "label": "See a session's or task's worktrees",
          "word": "attached",
          "line": "/worktree attached <attached to> <its id>",
          "sentence": "Shows the worktrees tied to {kind} {id} and their states.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Attached to",
              "help": "A session or a task",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "A session"
                },
                {
                  "value": "task",
                  "label": "A task"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "id",
              "label": "Its id",
              "help": "The session's or task's id",
              "kind": "text",
              "freeTextReason": "an id from /sessions or /tasks",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "recover",
          "label": "See how to recover a session's or task's worktrees",
          "word": "recover",
          "line": "/worktree recover <attached to> <its id>",
          "sentence": "Shows the worktrees tied to {kind} {id} and the line that brings each back.",
          "done": "",
          "touches": "reads",
          "lasts": "not-a-change",
          "risk": "none",
          "operator": {
            "terminalOnly": "Done from a terminal app."
          },
          "inputs": [
            {
              "id": "kind",
              "label": "Attached to",
              "help": "A session or a task",
              "kind": "choice",
              "choices": [
                {
                  "value": "session",
                  "label": "A session"
                },
                {
                  "value": "task",
                  "label": "A task"
                }
              ],
              "required": true,
              "typed": {
                "position": 1
              }
            },
            {
              "id": "id",
              "label": "Its id",
              "help": "The session's or task's id",
              "kind": "text",
              "freeTextReason": "an id from /sessions or /tasks",
              "required": true,
              "typed": {
                "position": 2
              }
            }
          ]
        },
        {
          "id": "pause",
          "label": "Pause a worktree",
          "word": "pause",
          "line": "/worktree pause <worktree>",
          "sentence": "{worktree} is marked paused until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The worktree list is read from this project."
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "resume",
          "label": "Resume a worktree",
          "word": "resume",
          "line": "/worktree resume <worktree>",
          "sentence": "{worktree} is marked active again until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The worktree list is read from this project."
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "keep",
          "label": "Keep a worktree",
          "word": "keep",
          "line": "/worktree keep <worktree>",
          "sentence": "{worktree} is marked kept, so the retention sweep leaves it, until you change it.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "none",
          "operator": {
            "terminalOnly": "The worktree list is read from this project."
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "discard",
          "label": "Remove a worktree",
          "word": "discard",
          "line": "/worktree discard <worktree>",
          "sentence": "{worktree} is removed from disk; its branch is kept and anything uncommitted is saved on it first.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "method": "worktrees.discard",
            "fields": {
              "path": "worktree"
            }
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        },
        {
          "id": "cleanup",
          "label": "Stop tracking a worktree that is gone",
          "word": "cleanup",
          "line": "/worktree cleanup <worktree>",
          "sentence": "{worktree}'s tracking record is removed; use it once the worktree itself is gone.",
          "done": "",
          "touches": "this-machine",
          "lasts": "kept",
          "risk": "cannot-be-undone",
          "riskWords": "cannot be undone",
          "operator": {
            "terminalOnly": "The worktree list is read from this project."
          },
          "inputs": [
            {
              "id": "worktree",
              "label": "Worktree",
              "help": "The worktrees of this project",
              "kind": "choice",
              "choices": {
                "list": "worktrees",
                "allowOther": {
                  "reason": "a worktree path that is not tracked"
                }
              },
              "required": true,
              "typed": {
                "position": 1
              }
            }
          ]
        }
      ]
    }
  ],
  "lists": {
    "accounts.providers": {
      "method": "accounts.snapshot",
      "input": {},
      "rows": {
        "from": "providers",
        "value": "providerId",
        "label": "providerId"
      }
    },
    "auth.providers": {
      "terminalOnly": "Provider sign-ins are read from the terminal app's own stores."
    },
    "fleet.workstreams": {
      "method": "fleet.list",
      "input": {},
      "rows": {
        "from": "items",
        "value": "id",
        "label": "label",
        "state": "state"
      }
    },
    "held-calls": {
      "terminalOnly": "Held calls belong to the terminal session that held them."
    },
    "hooks.managed": {
      "terminalOnly": "Managed hooks are kept in this machine's hooks file."
    },
    "hosted.running-tools": {
      "terminalOnly": "The running tools are those of the session this terminal joined."
    },
    "hosted.sessions": {
      "method": "sessions.hosted.list",
      "input": {},
      "rows": {
        "from": "sessions",
        "value": "id",
        "label": "title",
        "state": "status"
      }
    },
    "inbox.all": {
      "method": "inbox.list",
      "input": {
        "status": "all"
      },
      "rows": {
        "from": "items",
        "value": "id",
        "label": "title",
        "state": "status"
      }
    },
    "inbox.decisions": {
      "method": "inbox.list",
      "input": {
        "status": "open",
        "kinds": "decision"
      },
      "rows": {
        "from": "items",
        "value": "id",
        "label": "title"
      }
    },
    "inbox.open": {
      "method": "inbox.list",
      "input": {
        "status": "open"
      },
      "rows": {
        "from": "items",
        "value": "id",
        "label": "title",
        "state": "kind"
      }
    },
    "local-auth.sessions": {
      "method": "local_auth.status",
      "input": {},
      "rows": {
        "from": "sessions",
        "value": "id",
        "label": "username",
        "detail": "id"
      }
    },
    "local-auth.users": {
      "method": "local_auth.status",
      "input": {},
      "rows": {
        "from": "users",
        "value": "username",
        "label": "username"
      }
    },
    "managed.profiles": {
      "terminalOnly": "Managed settings are kept on this machine."
    },
    "managed.rollbacks": {
      "terminalOnly": "Managed settings are kept on this machine."
    },
    "marketplace.backups": {
      "terminalOnly": "The catalog and what is installed are on this machine."
    },
    "marketplace.catalog": {
      "terminalOnly": "The catalog and what is installed are on this machine."
    },
    "marketplace.installed": {
      "terminalOnly": "The catalog and what is installed are on this machine."
    },
    "mcp.servers": {
      "method": "mcp.config.get",
      "input": {},
      "rows": {
        "from": "servers",
        "value": "name",
        "label": "name",
        "detail": "source.path"
      }
    },
    "mcp.servers.held-back": {
      "method": "mcp.servers.list",
      "input": {},
      "rows": {
        "from": "security",
        "where": {
          "field": "schemaFreshness",
          "equals": "quarantined"
        },
        "value": "name",
        "label": "name",
        "detail": "quarantineReason"
      }
    },
    "mcp.tools": {
      "method": "mcp.tools.list",
      "input": {},
      "rows": {
        "from": "tools",
        "where": {
          "field": "serverName",
          "equals": "{server}"
        },
        "value": "toolName",
        "label": "toolName",
        "detail": "description"
      }
    },
    "mcp.tools.blocked": {
      "method": "mcp.config.get",
      "input": {},
      "rows": {
        "from": "servers",
        "where": {
          "field": "name",
          "equals": "{server}"
        },
        "each": "deniedTools",
        "value": ".",
        "label": "."
      }
    },
    "mcp.tools.exempt": {
      "method": "mcp.config.get",
      "input": {},
      "rows": {
        "from": "servers",
        "where": {
          "field": "name",
          "equals": "{server}"
        },
        "each": "allowedTools",
        "value": ".",
        "label": "."
      }
    },
    "memory.copies": {
      "method": "memory.snapshots.list",
      "input": {},
      "rows": {
        "from": "snapshots",
        "value": "name",
        "label": "name",
        "detail": "reason"
      }
    },
    "memory.file-proposals": {
      "terminalOnly": "Memory files live in the terminal app's project."
    },
    "memory.records": {
      "method": "memory.records.list",
      "input": {},
      "rows": {
        "from": "records",
        "value": "id",
        "label": "summary",
        "detail": "id",
        "state": "cls"
      }
    },
    "my-skills": {
      "terminalOnly": "Agent-local skills are kept on this machine."
    },
    "my-skills.bundles": {
      "terminalOnly": "Agent-local skills are kept on this machine."
    },
    "my-skills.discovered": {
      "terminalOnly": "Agent-local skills are kept on this machine."
    },
    "payments.cards": {
      "method": "payments.cards.list",
      "input": {},
      "rows": {
        "from": "cards",
        "value": "id",
        "label": "label",
        "detail": "last4"
      }
    },
    "payments.repeats": {
      "method": "payments.standing.list",
      "input": {},
      "rows": {
        "from": "authorizations",
        "value": "id",
        "label": "item",
        "detail": "summary"
      }
    },
    "payments.shops": {
      "method": "payments.purchases.list",
      "input": {},
      "rows": {
        "from": "purchases",
        "value": "merchantDomain",
        "label": "merchantDomain"
      }
    },
    "permissions.rules": {
      "method": "permissions.rules.list",
      "input": {},
      "rows": {
        "from": "rules",
        "value": "id",
        "label": "description",
        "state": "effect"
      }
    },
    "plugin.catalog": {
      "terminalOnly": "The curated catalog is on this machine."
    },
    "plugins": {
      "terminalOnly": "Plugins run inside each terminal app."
    },
    "remote.artifacts": {
      "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
    },
    "remote.connections": {
      "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
    },
    "remote.pool-runners": {
      "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
    },
    "remote.pools": {
      "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
    },
    "remote.runners": {
      "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
    },
    "remote.supervised": {
      "terminalOnly": "Remote runners belong to the terminal app that dispatched them."
    },
    "schedules": {
      "method": "automation.schedules.list",
      "input": {},
      "rows": {
        "from": "jobs",
        "value": "id",
        "label": "name",
        "detail": "description"
      }
    },
    "schedules.paused": {
      "method": "automation.schedules.list",
      "input": {},
      "rows": {
        "from": "jobs",
        "where": {
          "field": "enabled",
          "equals": "false"
        },
        "value": "id",
        "label": "name",
        "detail": "description"
      }
    },
    "schedules.running": {
      "method": "automation.schedules.list",
      "input": {},
      "rows": {
        "from": "jobs",
        "where": {
          "field": "enabled",
          "equals": "true"
        },
        "value": "id",
        "label": "name",
        "detail": "description"
      }
    },
    "secrets.stored": {
      "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
    },
    "secrets.unconfirmed": {
      "terminalOnly": "Secrets are kept by the app that reads them; manage them in a terminal app."
    },
    "sessions.branches": {
      "terminalOnly": "Branches belong to the conversation open in the terminal app."
    },
    "sessions.handoffs.waiting": {
      "terminalOnly": "The task graph is kept by the terminal app."
    },
    "sessions.saved": {
      "method": "sessions.list",
      "input": {},
      "rows": {
        "from": "sessions",
        "value": "id",
        "label": "title"
      }
    },
    "settings-sync.conflicts": {
      "terminalOnly": "Synced settings are kept on this machine."
    },
    "skills": {
      "terminalOnly": "Skills are found in this project and on this machine."
    },
    "skills.catalog": {
      "terminalOnly": "The curated catalog is on this machine."
    },
    "todo.items": {
      "terminalOnly": "The to-do list is this project's, kept by the terminal app that has the project open."
    },
    "triggers": {
      "method": "watchers.triggers.list",
      "input": {},
      "rows": {
        "from": "triggers",
        "value": "id",
        "label": "label",
        "detail": "watching",
        "state": "state"
      }
    },
    "triggers.commands": {
      "method": "watchers.triggers.grant.list",
      "input": {},
      "rows": {
        "from": "grants",
        "value": "id",
        "label": "id",
        "detail": "command"
      }
    },
    "workstreams": {
      "terminalOnly": "Workstreams belong to the terminal session that runs them."
    },
    "workstreams.plan-steps": {
      "terminalOnly": "Workstreams belong to the terminal session that runs them."
    },
    "workstreams.plans": {
      "terminalOnly": "Workstreams belong to the terminal session that runs them."
    },
    "workstreams.questions": {
      "terminalOnly": "Workstreams belong to the terminal session that runs them."
    },
    "workstreams.steps": {
      "terminalOnly": "Workstreams belong to the terminal session that runs them."
    },
    "worktrees": {
      "terminalOnly": "The worktree list is read from this project."
    }
  }
};
