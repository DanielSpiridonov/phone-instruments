// Sensor processing is independent of room polling and Web Audio.
const sensorClamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sensorAxes = ['x', 'y', 'z'];

class AirflowMotion {
  constructor() {
    this.sensitivity = 1;
    this.releaseSeconds = .7;
    this.reset();
  }
  reset() {
    this.count = 0; this.received = 0; this.last = null;
    this.gravity = null; this.raw = null; this.source = 'none';
    this.magnitude = 0; this.target = 0; this.airflow = 0;
  }
  sample(event, now) {
    this.received++;
    const linear = event.acceleration;
    const gravity = event.accelerationIncludingGravity;
    const linearCount = sensorAxes.filter(k => Number.isFinite(linear?.[k])).length;
    const gravityCount = sensorAxes.filter(k => Number.isFinite(gravity?.[k])).length;
    // Use complete linear acceleration. Missing axes fall back to gravity-
    // corrected acceleration; a partial linear vector is a last resort.
    const useLinear = linearCount === 3 || (gravityCount < 2 && linearCount >= 2);
    if (!useLinear && gravityCount < 2) return false;
    const dt = this.last === null ? 1 / 60 : sensorClamp((now - this.last) / 1000, .001, .1);
    let values;
    if (useLinear) {
      this.gravity = null;
      this.source = linearCount === 3 ? 'linear' : 'partial linear';
      this.raw = Object.fromEntries(sensorAxes.map(k => [k, Number.isFinite(linear[k]) ? linear[k] : null]));
      values = sensorAxes.map(k => this.raw[k] ?? 0);
    } else {
      this.source = 'gravity filtered';
      this.raw = Object.fromEntries(sensorAxes.map(k => [k, Number.isFinite(gravity[k]) ? gravity[k] : null]));
      if (!this.gravity) this.gravity = {...this.raw};
      const alpha = 1 - Math.exp(-dt / .45);
      values = sensorAxes.map(k => {
        const value = this.raw[k];
        if (value === null) return 0;
        if (this.gravity[k] === null) this.gravity[k] = value;
        this.gravity[k] += alpha * (value - this.gravity[k]);
        return value - this.gravity[k];
      });
    }
    this.magnitude = Math.hypot(...values);
    // Spread ordinary hand movement across the meter. The gentle curve keeps
    // small motion audible while full airflow needs a deliberate strong move.
    const normalized = Math.max(0, (this.magnitude - .12) / 5);
    this.target = sensorClamp(Math.pow(normalized, .65) * this.sensitivity, 0, 1);
    this.last = now; this.count++;
    return true;
  }
  step(now, dt) {
    const target = this.last !== null && now - this.last < 300 ? this.target : 0;
    const tau = target > this.airflow ? .09 : this.releaseSeconds;
    this.airflow += (target - this.airflow) * (1 - Math.exp(-dt / tau));
    if (this.airflow < .001) this.airflow = 0;
    return this.airflow * 100;
  }
}

const wrapDegrees = angle => ((angle + 180) % 360 + 360) % 360 - 180;
const circularMean = (sin, cos) => Math.atan2(sin, cos) * 180 / Math.PI;

class TiltTone {
  constructor() {
    this.sensitivity = 1;
    this.reset();
  }
  reset() {
    this.count = 0; this.last = null; this.raw = null; this.neutral = null;
    this.calibration = null; this.screenForward = 0; this.screenSide = 0;
    this.lastScreenAngle = null; this.screenChanged = false;
    this.degrees = 0; this.target = 0; this.brightness = 0;
    this.frequency = 1200;
  }
  beginCalibration(now) {
    this.calibration = {since:now, count:0, betaSin:0, betaCos:0, gammaSin:0, gammaCos:0};
    this.target = 0;
  }
  sample(event, screenAngle, now) {
    if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return false;
    const beta = event.beta, gamma = event.gamma;
    const angle = Number.isFinite(screenAngle) ? screenAngle : 0;
    this.screenChanged = this.lastScreenAngle !== null && angle !== this.lastScreenAngle;
    this.lastScreenAngle = angle;
    this.raw = {beta, gamma, screenAngle:angle};
    this.last = now; this.count++;
    if (this.screenChanged) {
      this.neutral = {beta,gamma};
      this.calibration = null;
    }
    if (this.calibration) {
      const c = this.calibration;
      for (const [axis, value] of [['beta',beta],['gamma',gamma]]) {
        const radians=value*Math.PI/180;
        c[axis+'Sin']+=Math.sin(radians);
        c[axis+'Cos']+=Math.cos(radians);
      }
      c.count++;
      if (now-c.since >= 600 && c.count >= 4) {
        this.neutral = {beta:circularMean(c.betaSin,c.betaCos),gamma:circularMean(c.gammaSin,c.gammaCos)};
        this.calibration = null;
      } else {
        this.target = 0;
        return true;
      }
    }
    if (!this.neutral) this.neutral = {beta,gamma};
    const deltaBeta = wrapDegrees(beta - this.neutral.beta);
    const deltaGamma = wrapDegrees(gamma - this.neutral.gamma);
    const radians = angle*Math.PI/180;
    // Beta/gamma are defined in the phone's portrait axes. Rotate that pair
    // into the current screen axes before weighting forward and sideways tilt.
    this.screenForward = deltaBeta*Math.cos(radians) - deltaGamma*Math.sin(radians);
    this.screenSide = deltaBeta*Math.sin(radians) + deltaGamma*Math.cos(radians);
    this.degrees = Math.hypot(this.screenForward, .7*this.screenSide);
    this.target = sensorClamp((this.degrees - 1.5)*this.sensitivity/30, 0, 1);
    return true;
  }
  step(now, dt) {
    const target = this.last !== null && now-this.last < 750 ? this.target : 0;
    this.brightness += (target - this.brightness)*(1-Math.exp(-dt/.12));
    if (this.brightness < .0001) this.brightness = 0;
    // Even at neutral, the low-pass remains above the highest played note.
    this.frequency = 1200 + 6800*this.brightness;
    return this.frequency;
  }
}

if (typeof module !== 'undefined') {
  module.exports = AirflowMotion;
  module.exports.TiltTone = TiltTone;
}
