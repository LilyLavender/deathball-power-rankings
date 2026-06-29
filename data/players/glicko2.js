// Glicko-2 rating system.
// Reference: http://www.glicko.net/glicko/glicko2.pdf
//
// Player state: { r, rd, sigma }
//   r     — rating (default 1500)
//   rd    — rating deviation / uncertainty (default 350; lower = more confident)
//   sigma — volatility, captures how erratic performance is (default 0.06)
//
// Usage:
//   const g2 = require('./glicko2');
//   let p = g2.createPlayer();
//   p = g2.updatePeriod(p, [{ r: 1400, rd: 30, score: 1 }, ...]);
//   p = g2.decayRd(p, monthsElapsed);
//   const display = g2.conservativeRating(p); // r - 2*rd

'use strict';

const SCALE = 173.7178;
const TAU = 0.5; // system constant — controls max volatility change per period

function toScale(r, rd) {
  return { mu: (r - 1500) / SCALE, phi: rd / SCALE };
}

function fromScale(mu, phi) {
  return { r: SCALE * mu + 1500, rd: SCALE * phi };
}

function gFn(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function eFn(mu, muJ, phiJ) {
  return 1 / (1 + Math.exp(-gFn(phiJ) * (mu - muJ)));
}

// Illinois algorithm to solve for new volatility sigma'.
function newVolatility(sigma, phi, v, delta) {
  const a = Math.log(sigma * sigma);
  const eps = 1e-6;

  const f = (x) => {
    const ex = Math.exp(x);
    const d2 = phi * phi + v + ex;
    return (ex * (delta * delta - d2)) / (2 * d2 * d2) - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);

  for (let i = 0; i < 500 && Math.abs(B - A) > eps; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

function createPlayer() {
  return { r: 1500, rd: 350, sigma: 0.06 };
}

// results: [{ r, rd, score }] where score ∈ [0, 1]
// All results must use pre-period opponent ratings (snapshot before this period begins).
function updatePeriod(player, results) {
  if (!results || results.length === 0) return player;

  const { mu, phi } = toScale(player.r, player.rd);
  const opponents = results.map(({ r, rd }) => toScale(r, rd));

  const v = 1 / results.reduce((sum, _r, i) => {
    const gv = gFn(opponents[i].phi);
    const ev = eFn(mu, opponents[i].mu, opponents[i].phi);
    return sum + gv * gv * ev * (1 - ev);
  }, 0);

  const innerSum = results.reduce((sum, { score }, i) => {
    const gv = gFn(opponents[i].phi);
    const ev = eFn(mu, opponents[i].mu, opponents[i].phi);
    return sum + gv * (score - ev);
  }, 0);

  const delta = v * innerSum;
  const sigmaPrime = newVolatility(player.sigma, phi, v, delta);
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * innerSum;

  const { r, rd } = fromScale(muPrime, phiPrime);
  return { r, rd, sigma: sigmaPrime };
}

// Inflate rd for inactivity. Uses quadratic growth capped at maxRd.
// Spread any extra props on player (e.g. lastActiveDate) through unchanged.
function decayRd(player, monthsElapsed, decayPerMonth = 5, maxRd = 350) {
  if (!monthsElapsed || monthsElapsed <= 0) return player;
  const newRd = Math.min(maxRd, Math.sqrt(player.rd * player.rd + Math.pow(decayPerMonth * monthsElapsed, 2)));
  return { ...player, rd: newRd };
}

// Lower bound of the ~95% confidence interval. Used as the ranking sort key.
function conservativeRating(player) {
  return player.r - 2 * player.rd;
}

module.exports = { createPlayer, updatePeriod, decayRd, conservativeRating };
