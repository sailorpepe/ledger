// The overtime tiers the app carries with it.
//
// The tiers normally come from data/contract.json, the agreement as data. On
// the web that file can fail to arrive — no signal and nothing cached yet, an
// error from the host, a wifi login page — and a day split with no tiers is
// all straight time: a 10-hour weekday sealed as 10 straight, in a log that
// can't be edited afterwards. So the current agreement's tiers also ship inside
// the app, and are used whenever the file's are missing.
//
// This is a copy of the overtime section of packages/data/src/contract.mjs.
// tests/overtime.test.mjs fails the moment the two disagree, so when the
// agreement changes, both change together.

const tiers = (...t) => Object.freeze(t.map((x) => Object.freeze(x)))

export const BUILT_IN_CONTRACT = Object.freeze({
  name: 'CAICA — Chicago Area Independent Construction Association',
  overtime: Object.freeze({
    weekday: Object.freeze({
      cite: 'Art. 15 ¶1, ¶3',
      tiers: tiers({ upto: 8, mult: 1 }, { upto: 12, mult: 1.5 }, { upto: null, mult: 2 }),
    }),
    saturday: Object.freeze({
      cite: 'Art. 15 ¶5',
      tiers: tiers({ upto: 10, mult: 1.5 }, { upto: null, mult: 2 }),
    }),
    sunday: Object.freeze({
      cite: 'Art. 17 ¶1',
      tiers: tiers({ upto: null, mult: 2 }),
    }),
    // Straight to 10 in a holiday week only; past 10 the weekday ¶3 runs on.
    fourTens: Object.freeze({
      cite: 'Art. 15 ¶1, ¶3',
      tiers: tiers({ upto: 10, mult: 1 }, { upto: 12, mult: 1.5 }, { upto: null, mult: 2 }),
    }),
  }),
})

// The contract whose overtime rules apply right now: the loaded one when it
// carries tiers, the built-in copy otherwise — including the moments before
// contract.json has arrived, when a member can already tap Log it.
export const overtimeSource = (contract) => (contract?.overtime ? contract : BUILT_IN_CONTRACT)
