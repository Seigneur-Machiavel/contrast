# Validator Selection Spectrum (VSS)

## Introduction
The Validator Selection Spectrum (VSS) is the core mechanism for staking-based validator selection in the Contrast blockchain. It ensures a fair, transparent, and cryptographically secure process for selecting block producers (validators) in each consensus round, based on their staking weight.

## Data Structures
- **Spectrum**: A mapping of integer keys to validator stake entries, representing the full set of eligible validators and their stake weights.
- **Legitimacies**: An ordered array of validator references, representing the legitimacy ranking for the current round.
- **Round Hash**: A cryptographically secure random value, unique for each round, used as the entropy for the legitimacy lottery.

## Staking & Spectrum Construction
1. Each validator locks a stake (coins) to participate in consensus.
2. The spectrum is constructed by mapping contiguous integer ranges to each validator, proportional to their stake (e.g. a validator with 10% of total stake covers 10% of the spectrum range).
3. The spectrum covers the full range `[0, totalStake-1]`.

## Legitimacy Draw (Lottery)
At the beginning of each round:
1. The round hash is computed (using previous block hash, round number, etc.).
2. For each legitimacy slot (e.g. top 27), a random integer in `[0, totalStake-1]` is drawn using the round hash as entropy (with rejection sampling to avoid bias).
3. The validator whose spectrum range includes the drawn integer is assigned that legitimacy slot.
4. No validator can be selected twice for the same round.

This process produces a deterministic, unbiased, and stake-weighted random ranking of validators for the round.

## Security & Fairness
- The process is deterministic (all honest nodes compute the same result for the same inputs).
- The round hash is unpredictable and cannot be manipulated by a single party.
- Stake-weighted selection ensures Sybil resistance: more stake = higher chance of being selected.
- Rejection sampling guarantees uniformity and fairness.

## Example
Suppose 3 validators:
- Alice: 60 coins
- Bob: 30 coins
- Carol: 10 coins
Total stake = 100 coins

Spectrum:
```
[0........59]   → Alice
[60......89]    → Bob
[90......99]    → Carol
```
If the draw for slot 1 gives 67, Bob is selected. If slot 2 gives 12, Alice is selected, etc.

## Diagram
```
|---------------------- Spectrum (0..99) ----------------------|
|    Alice    |    Bob   | Carol |
| 0......59   | 60..89   | 90..99|

Round Hash → Random Draws → Slot Assignment

For each slot:
  slotN = hashToIntWithRejection(roundHash, slotN, maxRange=100)
  winner = spectrum[slotN]
```

## Dependencies
- conCrypto.mjs
- mini-logger.mjs
