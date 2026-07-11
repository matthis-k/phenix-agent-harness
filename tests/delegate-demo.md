# Phenix Delegate Flow Demo

A silly test flow exercising: **Planner → Implementer → Critic** handoffs with structured schemas.

## Setup

Type `/reload` in the TUI once to load the fix extension, then paste and run:

---

## Step 1: Planner

```
Call phenix_delegate with:
  role=planner
  task="[TEST silly] Design a bash script 'deeply-silly-greeting.sh'.
    Requirements:
    1. Print greeting to $TARGET (default: 'wobbly wombat')
    2. Declare variable blorple=42
    3. Random moon compliment from ≥3 options
    4. Countdown from $BLORPLE to 'Blorple blastoff!'
    5. Random deep thought from ≥2 options
    6. --loud flag that uppercases output
    7. Valid bash

    Output plan with structure, variables, and compliance checks the critic can verify.
    Children know this is a TEST."

  outputSchema={
    "type": "object",
    "required": ["planName", "filePath", "structure", "variables", "complianceChecks"],
    "properties": {
      "planName": {"type": "string"},
      "filePath": {"type": "string"},
      "structure": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["section", "purpose"],
          "properties": {
            "section": {"type": "string"},
            "purpose": {"type": "string"}
          }
        }
      },
      "variables": {"type": "object", "additionalProperties": {"type": "string"}},
      "complianceChecks": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["id", "description", "howToVerify"],
          "properties": {
            "id": {"type": "string"},
            "description": {"type": "string"},
            "howToVerify": {"type": "string"}
          }
        }
      }
    }
  }

Tell me the planName and list the complianceCheck IDs.
```

## Step 2: Implementer

After getting the plan, feed it forward:

```
Call phenix_delegate with:
  role=implementer
  task="[TEST silly] Write the bash script at <filePath from plan> following this plan:

    <paste the plan JSON here>

    The script must be valid bash and pass all compliance checks.
    Children know this is a TEST."

  outputSchema={
    "type": "object",
    "required": ["filePath", "scriptContent", "complianceResults"],
    "properties": {
      "filePath": {"type": "string"},
      "scriptContent": {"type": "string"},
      "complianceResults": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["checkId", "passed", "evidence"],
          "properties": {
            "checkId": {"type": "string"},
            "passed": {"type": "boolean"},
            "evidence": {"type": "string"}
          }
        }
      }
    }
  }

Tell me the filePath and which checks passed.
```

## Step 3: Critic

```
Call phenix_delegate with:
  role=critic
  task="[TEST silly] Review the script at <filePath> against the original plan:

    Plan compliance checks:
    - <list from step 1>

    Children know this is a TEST. Look for:
    - Missing requirements
    - bash syntax errors
    - Incorrect behavior

    Read the script file and evaluate each check."

  outputSchema={
    "type": "object",
    "required": ["verdict", "summary", "findings"],
    "properties": {
      "verdict": {"enum": ["approve", "reject"]},
      "summary": {"type": "string"},
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["severity", "description", "evidence"],
          "properties": {
            "severity": {"enum": ["minor", "major", "critical"]},
            "description": {"type": "string"},
            "evidence": {"type": "string"}
          }
        }
      }
    }
  }

Tell me the verdict and how many findings.
```

---

## Expected behaviors to observe

| What | Why it matters |
|---|---|
| Each child runs in an isolated Pi process | Verifies real process isolation with separate context windows |
| Structured output schema enforced at handoff | Verifies the contract system — invalid output gets rejected with schema errors |
| Runtime model routing | The planner might get a different model than the implementer based on policy |
| Verification commands run independently | The runtime runs verification AFTER the child finishes |
| Critic gate runs after implementer | An independent reviewer catches issues the implementer missed |
| Policy enforcement | The `childAllowed` graph restricts which roles can spawn which children |

## Cleanup

```
rm -f deeply-silly-greeting.sh
```
