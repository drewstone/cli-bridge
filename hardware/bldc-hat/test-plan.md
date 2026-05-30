# Bring-Up & Test Plan — bldc-hat Rev A

## Equipment Required

- Bench PSU: 0–30V, 10A with current limiting (e.g., Rigol DP832)
- DMM: Fluke 87V or equivalent
- Oscilloscope: 4-channel, ≥ 100MHz, current probe preferred (e.g., Rigol DS1054Z + CP4020)
- RPi 4B or 3B+ with SD card flashed (Raspberry Pi OS Lite)
- Logic analyzer (optional but recommended): Saleae Logic 8
- BLDC motor: 24V, rated ≥ 5A (test load); or resistive load 4.8Ω 50W × 3 for open-loop testing
- Anti-static wrist strap + mat

---

## Phase 0: Pre-Power Visual Inspection (no power applied)

| Step | Check | Pass |
|------|-------|------|
| P0-1 | All ICs correctly oriented (pin 1 markers match silkscreen) | |
| P0-2 | No solder bridges on DRV8305 HTSSOP-38 pins (40× magnification) | |
| P0-3 | No bridges on FET pads (Q1–Q6) | |
| P0-4 | Electrolytic cap polarity correct (C1–C4 negative stripe = GND) | |
| P0-5 | LEDs oriented correctly (cathode on marked pad) | |
| P0-6 | XT30 connector mechanically secure | |
| P0-7 | RPi 40-pin header fully seated | |
| P0-8 | Fuse installed (F1) | |
| P0-9 | Shunt resistors R_sh1–R_sh3 populated (2512 package, tall profile) | |
| P0-10 | DMM: PVDD to GND ≥ 10kΩ cold (no power path shorts) | |
| P0-11 | DMM: 5V to GND ≥ 1kΩ cold | |
| P0-12 | DMM: Phase A to GND — should read open (FETs off) | |

---

## Phase 1: Logic-Only Bring-Up (no motor bus, 5V via RPi USB)

Set bench PSU to current limit = 500mA.  
Power board via RPi USB **only** (motor XT30 disconnected).

| Step | Procedure | Expected | Pass |
|------|-----------|----------|------|
| 1-1 | Apply 5V USB to RPi | LED1 (green) illuminates | |
| 1-2 | DMM: measure 5V rail (TP2) | 4.9–5.1V | |
| 1-3 | DMM: measure 3.3V on DRV8305 VDD (U1 pin 1) | 3.15–3.45V | |
| 1-4 | DMM: check RPi 3.3V (RPi header pin 1) | 3.15–3.45V | |
| 1-5 | Check nSLEEP = LOW (DRV8305 in sleep, nSLEEP pin tied low through R13) | nSLEEP = GND | |
| 1-6 | SPI test: run `python3 drv_read.py` — read DRV8305 register 0x00 | Returns 0x0000 (no fault) | |
| 1-7 | Assert nSLEEP HIGH via GPIO: `raspi-gpio set 27 op dh` | No change visually; DRV8305 wakes (monitor current draw) | |
| 1-8 | Read DRV8305 STATUS_REG_1 (0x00) via SPI | 0x0000 — VDD_OCP, PVDD_UVFL etc. clear | |
| 1-9 | Deassert nSLEEP (BCM27 LOW); verify DRV8305 sleep mode | | |
| 1-10 | Logic analyzer: verify SPI CPOL=1 CPHA=1, SCK idle HIGH | Correct SPI timing | |

---

## Phase 2: Motor Bus Bring-Up (24V, no motor load)

Disconnect RPi USB. Connect bench PSU to XT30 at **5V initially, 500mA limit**.

| Step | Procedure | Expected | Pass |
|------|-----------|----------|------|
| 2-1 | Apply 5V to XT30 | LED1 illuminates; PSU reads ~60mA | |
| 2-2 | Measure buck output (U2) with 5V in | Vout = 5.0V (no load) | |
| 2-3 | Measure DRV8305 PVDD pin | 5V (via TVS, bulk caps) | |
| 2-4 | Increase PSU to 12V, 1A limit | Buck output stable 5V; DRV8305 wakes | |
| 2-5 | Increase PSU to 24V, 2A limit | Buck output = 5.0V ± 0.1V; total draw < 200mA | |
| 2-6 | Verify LED1 on, LED2 (fault) off | | |
| 2-7 | Scope: measure switching ripple on 5V rail (TP2) | < 50mV pp | |
| 2-8 | Scope: measure PVDD bulk cap ripple at 24V no load | < 50mV pp | |
| 2-9 | DMM: measure 3.3V at DRV8305 VDD | 3.15–3.45V | |
| 2-10 | Assert nSLEEP HIGH; read DRV8305 STAT_REG_1 | 0x0000 (PVDD present) | |
| 2-11 | Verify PVDD_OV threshold: ramp to 30V | DRV8305 nFAULT asserts at ~30V (OV threshold) | |
| 2-12 | Return to 24V | nFAULT clears; normal operation | |

---

## Phase 3: Gate Drive Verification (no motor, oscilloscope)

RPi running motor test script (PWM generation via GPIO or SPI config).  
Scope probe × 10 on each phase output.

| Step | Procedure | Expected | Pass |
|------|-----------|----------|------|
| 3-1 | Configure DRV8305 PWM mode: 6× independent | SPI register write OK | |
| 3-2 | Apply 10kHz 50% duty square wave to INH1/INL1 (Phase A HS+LS) | Phase A output = 0–24V square, 10kHz | |
| 3-3 | Scope: measure dead time (HS off → LS on) | 180–220ns (target 200ns) | |
| 3-4 | Scope: no shoot-through — both HS and LS never on simultaneously | < 5ns overlap | |
| 3-5 | Scope: gate drive waveform — clean rising/falling edges at FET gate | No ringing > 2V; Tr ≈ 40–100ns | |
| 3-6 | Repeat steps 3-2 through 3-5 for Phase B and Phase C | Same results | |
| 3-7 | Scope: bootstrap voltage (V_BS) at PHASE_A with 10% duty HS | V_BS ≈ 4.5–5V above PHASE_A | |
| 3-8 | Verify 100% duty HS via charge pump: set INH1 constant HIGH | Phase A stays HIGH continuously; charge pump maintains V_BS | |

---

## Phase 4: Current Sense Verification

Use external resistive load: 4.8Ω 50W wire-wound (simulates 5A at 24V).  
Connect between Phase A and Phase B (for open-loop 2-phase test).

| Step | Procedure | Expected | Pass |
|------|-----------|----------|------|
| 4-1 | Configure CSA gain = 10 V/V (SPI) | Register readback confirms | |
| 4-2 | Apply 1A through shunt (use PSU in current-limit mode via load) | CSA_A output = (1A × 5mΩ × 10) = 50mV above Vref/2 (1.65V) → 1.70V | |
| 4-3 | Verify with DMM on TP9 (CSA_A) | 1.65V + (I × 50mV/A) ± 5% | |
| 4-4 | Apply 5A through shunt | CSA output ≈ 1.90V (1.65 + 0.25) | |
| 4-5 | Apply 8A (overcurrent threshold test) | DRV8305 latches fault (LED2 red, nFAULT low) | |
| 4-6 | Reset fault (nSLEEP cycle); verify recovery | nFAULT clears, no permanent damage | |
| 4-7 | Kelvin sense verification: apply DC current, compare DMM vs calculated | Difference < 5% | |

---

## Phase 5: Full Motor Test

Connect 24V BLDC motor (rated ≤ 5A, ≤ 120W) to J3.  
Use SimpleFOC or custom Python SPI driver.  
Start at low duty cycle (10%) before ramping.

| Step | Procedure | Expected | Pass |
|------|-----------|----------|------|
| 5-1 | Hall sensor connection: verify HALL_A/B/C read correct 6-step pattern as shaft rotated by hand | Each step change detectable via BCM22/23/24 | |
| 5-2 | Open loop, 10% duty: all three phases active | Motor hums, slight rotation | |
| 5-3 | Commutation order check: motor rotates in expected direction | If backwards, swap any 2 motor phase leads | |
| 5-4 | Ramp to 1A: measure phase current with clamp meter | 0.9–1.1A per phase | |
| 5-5 | Ramp to 5A sustained: board temp check after 60s | FETs < 70°C (touch/IR thermometer), DRV8305 < 80°C | |
| 5-6 | Load step: apply mechanical brake briefly | DRV8305 handles inrush; no fault | |
| 5-7 | Current telemetry: verify MCP3204 readings (if U4 populated) | CSA A/B/C match clamp meter readings ± 10% | |
| 5-8 | Motor spin-down: disable PWM | Motor coasts to stop; no voltage spikes > 30V on phase outputs | |
| 5-9 | 2-hour soak test at 3A continuous | No fault assertions, thermal steady-state reached | |

---

## Phase 6: Regulatory / Compliance (pre-production)

- [ ] Conducted emissions: CE/FCC Class B emissions test (if product goes to market)
- [ ] ESD: IEC 61000-4-2 Level 2 (±4kV contact, ±8kV air) on accessible connectors
- [ ] Surge: IEC 61000-4-5 (1kV on power input via coupling network)
- [ ] Vibration/shock: per end-use mechanical spec (if applicable)
- [ ] Temperature cycling: −10 to +70°C, 3 cycles, verify no solder joint cracking
- [ ] EEPROM programming verification: automated fixture for production

---

## Known Failure Modes & Debug

| Symptom | Likely Cause | Debug |
|---------|--------------|-------|
| LED1 off, no 5V | Buck not switching; fuse blown; reverse polarity | Check F1, check PVDD rail, scope U2 SW pin for switching |
| LED2 (fault) on immediately | PVDD UVLO, OCP latch, or SPI not configured | Read DRV8305 STATUS registers via SPI; check PVDD voltage |
| Phases stuck HIGH or LOW | Shoot-through protection latched; bootstrapping failed | Check V_BS voltage; read DRV8305 fault bits |
| Motor twitches but won't spin | Wrong commutation order; Hall sensors not read | Scope HALL_A/B/C during shaft rotation; verify commutation table |
| FETs overheating | Missing thermal vias; insufficient dead time; too high current | Verify thermal via connection to GND plane; reduce PWM duty |
| SPI readback always 0xFF | SDO not connected; wrong SPI mode | Check CS pin timing; verify CPOL/CPHA = 1/1; scope SDO |
| CSA reads flat line | Shunt resistors missing; wrong CSA gain setting | Measure shunt voltage directly with differential probe |
