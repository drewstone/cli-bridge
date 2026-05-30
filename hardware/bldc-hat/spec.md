# RPi BLDC Motor Driver HAT — Design Specification Rev A

**Project:** bldc-hat  
**Revision:** A  
**Date:** 2026-05-29  
**Author:** Drew Stone  
**IPC Class:** 2 (IPC-A-610G)  
**Status:** Released for layout

---

## 1. System Requirements

| Parameter | Min | Typ | Max | Unit | Notes |
|-----------|-----|-----|-----|------|-------|
| Motor bus voltage (PVDD) | 18 | 24 | 28 | V DC | TVS clamps at 36V |
| Continuous phase current | — | 5 | — | A RMS | Per winding |
| Peak phase current (≤2 s) | — | — | 8 | A | OCP threshold |
| PWM frequency | 10 | 20 | 40 | kHz | Set via SPI |
| Motor phases | — | 3 | — | — | 3-phase BLDC/PMSM |
| Logic supply (VDD) | 3.135 | 3.3 | 3.465 | V | From RPi 3V3 header |
| Buck output (5V rail) | 4.9 | 5.0 | 5.1 | V | Feeds RPi + accessories |
| Buck output current | — | — | 3 | A | LMR33630 limit |
| Operating temperature | 0 | 25 | 70 | °C | Ambient |
| Storage temperature | −40 | — | 125 | °C | |
| PCB form factor | — | 65.0 × 56.5 | — | mm | RPi HAT standard |
| Mounting | — | 4× M2.5 | — | — | At HAT-spec coordinates |
| Interface to host | — | SPI0 | — | — | CPOL=1, CPHA=1, ≤4 MHz |
| Hall sensor input voltage | — | 5 | — | V | Open-drain pull-up to 3.3V |

---

## 2. Architecture

```
 24V PSU ─── XT30 ─── F1 (7.5A) ─── D_RPol ─────────────────────── PVDD_BUS
                                                  │
                                           C_bulk (4× 100µF + 4× 4.7µF)
                                           TVS1 (SMAJ36A)
                                                  │
                    ┌─────────────────────────────┴─────────────────────┐
                    │                                                     │
             LMR33630BDDA                                       DRV8305NDCA
             24V → 5V, 3A                                    3-phase gate driver
                    │                                        PVDD = 24V, VDD = 3.3V
                  5V rail ──── RPi 5V (pin 2/4)                         │
                    │            │                              3× inline CSA
                  AP2112K      RPi 3V3 ──────── VDD              │
                  5V → 3.3V      │                              MCP3204 (SPI ADC)
                    │          GPIO SPI0 ── SPI ──┤                      │
                  3V3_AUX     GPIO BCM17 ── nFAULT                CSA_A, CSA_B, CSA_C
                                GPIO BCM27 ── nSLEEP
                                GPIO BCM22/23/24 ── HALL A/B/C

                                                      DRV8305 GATE DRIVE
                                                      Q1(HS) ─ PhA
                                                      Q4(LS) ─ PhA
                                                      Q2(HS) ─ PhB      → J3 3-pin
                                                      Q5(LS) ─ PhB        Motor
                                                      Q3(HS) ─ PhC
                                                      Q6(LS) ─ PhC
                                                      R_sh (5mΩ, 3× LS)
```

---

## 3. Block Descriptions

### 3.1 Reverse Polarity & EMC Input

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| J2 | XT30PW-M | — | 24V power input, 30A rated |
| F1 | Littelfuse 0481007.WT | 7.5A / 32V | Blade fuse, fast-blow |
| Q_RPol | PSMN4R0-40BS (P-ch MOSFET) | 40V, −7A | Ideal-diode-style reverse polarity |
| TVS1 | SMAJ36A | 36V, 400W peak | Transient voltage suppression |
| C1–C4 | EEU-FR1V101 (Panasonic) | 100µF 35V electrolytic | Bulk capacitance, low ESR |
| C5–C8 | GRM21BR61A475KE51L | 4.7µF 10V X5R 0805 | HF decoupling |

**Reverse polarity:** Gate of Q_RPol is tied to GND through 100kΩ. When polarity is correct, Vgs < −1V so Q_RPol conducts (S→D). When reversed, Vgs = 0 so FET is off. Use **LTC4359** gate driver IC for clean implementation: SENSE pin connects through 10mΩ sense resistor; LTC4359 drives gate to minimise Vdrop.

### 3.2 Buck Regulator (24V → 5V/3A)

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| U2 | LMR33630BDDA | 4–36V in, 3A | Synchronous buck |
| L1 | SLF12575T-6R8N4R0-PF (TDK) | 6.8µH, 4A, 35mΩ DCR | Buck inductor |
| C9 | GRM21BR61A106KE19L | 10µF 10V X5R 0805 | Buck input bypass |
| C10 | GRM21BR71H104KA01L | 100nF 50V X7R 0402 | Buck input HF bypass |
| C11–C12 | GRM21BR61A226ME44L | 22µF 10V X5R 0805 | Buck output cap |
| C13 | GRM21BR71H104KA01L | 100nF 50V X7R 0402 | Buck output HF bypass |
| R1 | CRCW0402100KFKED | 100kΩ, 1%, 0402 | Feedback top (RFBT) |
| R2 | CRCW040233K2FKED | 33.2kΩ, 1%, 0402 | Feedback bottom (RFBB) |

Output voltage: Vout = 0.8V × (1 + R1/R2) = 0.8 × (1 + 100/33.2) = **5.01V** ✓  
Switching frequency: 400kHz (internal, per LMR33630 default for this Rt combination — tie Rt to GND for max freq, use RFBT/RFBB table).  
Inductor ripple current: ΔIL = (Vin − Vout) × D / (fsw × L) = 19 × 0.208 / (400k × 6.8µ) = **1.45A**  

EN pin: tied HIGH (3.3V through 100kΩ) — always-on, or connect to RPi GPIO for software-enable.

### 3.3 3.3V LDO (5V → 3.3V, for DRV8305 VDD if needed)

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| U3 | AP2112K-3.3TRG1 | 600mA LDO SOT-25 | 3.3V for local logic |
| C14 | GRM21BR61A106KE19L | 10µF 10V X5R | LDO input cap |
| C15 | GRM21BR61A106KE19L | 10µF 10V X5R | LDO output cap |

Note: DRV8305 VDD pin draws < 5mA. It is acceptable to source 3.3V directly from RPi header pin 1 (3V3, max 50mA from regulator). U3 is populated for standalone operation (when no RPi attached) or high-current 3.3V accessories. DNP by default if only driving DRV8305 VDD.

### 3.4 Three-Phase Gate Driver

**IC: DRV8305NDCA** — HTSSOP-38 with PowerPAD (TI)

Key DRV8305 features used:
- PVDD: 8–65V (motor bus)
- VDD: 3.3V logic supply
- IDRIVE: configurable gate drive current (50mA–1A source, 100mA–2A sink)
- Dead time: 40ns–800ns (register-configurable)
- 3× inline current sense amps (CSA), gain 10/20/40 V/V
- nFAULT open-drain fault output
- SPI with 16-bit register map (full fault + config diagnostics)
- Charge pump for 100% duty cycle at high side

**SPI Configuration (startup sequence):**
```
Write 0x3860 → CTRL_REG_3: IDRIVE = 100mA src / 200mA sink
Write 0x3040 → CTRL_REG_3: PWM_MODE = 6x (independent HS/LS)
Write 0x1006 → CTRL_REG_1: dead-time = 200ns, OCP = 8A, OCP_MODE = latch
Write 0x2018 → CTRL_REG_2: CSA_GAIN = 20V/V (250mV full scale at 5A / 5mΩ)
```

**FETs (6× BSZ033N04LSI, Infineon, TDSON-8):**

| Parameter | Value |
|-----------|-------|
| Vds max | 40V |
| Id (25°C) | 43A |
| Rds(on) typ | 3.3mΩ |
| Package | TDSON-8, 3×3mm footprint |
| Gate threshold | 1.1V (logic-level compatible) |
| Qg total | 13nC |

At 5A continuous and Rds(on)=3.3mΩ: Pd = I²R = 25 × 0.0033 = **82.5mW per FET**  
Three FETs active simultaneously (upper or lower leg): total = **247mW**  
With 40°C/W junction-to-board: ΔTj = 247mW × 40 = 9.9°C — well within limits.

**Bootstrap circuit (per high-side):**

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| C_BS1–C_BS3 | GRM21BR71H104KA01L | 100nF 50V X7R 0402 | Bootstrap hold-up cap |
| D_BS1–D_BS3 | BAT54S (dual Schottky) | 30V 200mA SOT-23 | Bootstrap diode |

Bootstrap voltage: Vbs = 5V − Vf(BAT54S) ≈ 4.65V. DRV8305 gate drive output swings 0→VBS on high side.

**Gate resistors (10Ω per gate, 0402 0.1W):** R6–R17  
Slew rate with Ciss=2000pF: tr ≈ 2.2 × R_g × Ciss = 2.2 × 10 × 2000pF = **44ns**  
Adjust R_gate up to 47Ω to reduce EMI; down to 4.7Ω for lower switching losses.

**Current sense shunts:**

| Ref | Part | Value | Notes |
|-----|------|-------|-------|
| R18–R20 | Susumu RL3720T-R005-F | 5mΩ, 1%, 3W | 2512 package, Kelvin 4-terminal |

Placed on low-side FET source to GND path (single-shunt per phase).  
Kelvin connections: SP, SM separate traces to DRV8305 CSA+ and CSA− pins.  
At 5A: Vshunt = 25mV. At CSA gain 20: Vout = 500mV. Full-scale (gain 20, 3.3V ref): ±7.5A.

### 3.5 Current Monitor ADC (optional, default DNP)

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| U4 | MCP3204-CI/SL | 12-bit 4-ch SPI ADC | Current + Vbus monitoring |
| C16 | GRM21BR61A106KE19L | 10µF 10V | ADC Vdd bypass |

Connected to RPi SPI1 (BCM 16/19/20/21, CE1=BCM17? — use separate CS).  
Channels:
- CH0: CSA_A output
- CH1: CSA_B output
- CH2: CSA_C output
- CH3: Vbus / 10 (resistor divider: 91kΩ + 10kΩ → 24V → 2.4V, 12-bit = 5.9mV/LSB → 53mV/LSB on Vbus)

Vref for MCP3204: tied to 3.3V. LSB = 3.3V/4096 = 0.806mV.  
Current resolution at CSA gain 20: 0.806mV / (20 × 5mΩ) = **8.1mA per LSB** ✓

### 3.6 Hall Sensor Interface

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| J4 | PH-5P (JST) | 5-pin 2.0mm | Hall sensor connector |
| R21–R23 | CRCW040210K0FKED | 10kΩ, 0402 | Pull-up to 3.3V |
| R24–R26 | CRCW04020100FKED | 100Ω, 0402 | RC filter series resistor |
| C17–C19 | GRM15XR71H103KA88D | 10nF 50V X7R 0402 | RC filter shunt cap |

RC filter corner: f = 1/(2π × 100 × 10nF) = **159kHz** (passes commutation signals, rejects PWM noise)  
Hall supply: 5V (sourced from 5V rail through 1kΩ current-limiting resistor, pin 1)  
Logic output: 3.3V (pull-up to 3V3, level-compatible with RPi BCM)

Connector pinout (J4):
```
1: 5V_HALL (1kΩ series from 5V)
2: HALL_A
3: HALL_B
4: HALL_C
5: GND
```

### 3.7 HAT ID EEPROM

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| U5 | M24C02-WMN6TP | 2kbit I2C EEPROM | RPi HAT ID (mandatory) |
| R27 | CRCW04023K90FKED | 3.9kΩ | SDA pull-up to 3.3V |
| R28 | CRCW04023K90FKED | 3.9kΩ | SCL pull-up to 3.3V |
| R29 | DNP jumper | 0Ω | WP pin — install to write-protect after programming |

Connected to ID_SD (RPi header pin 27) and ID_SC (pin 28) — dedicated HAT EEPROM I2C bus.  
Address: 0x50 (A0=A1=GND).  
Must be programmed with HAT EEPROM format per RPi HAT specification before production.

### 3.8 Status Indicators & Test Points

| Ref | Part | Value | Function |
|-----|------|-------|----------|
| LED1 | APT2012CGCK | Green 0805 | 5V power OK (series 1kΩ) |
| LED2 | APT2012SURCK | Red 0805 | nFAULT (active, series 1kΩ) |
| TP1–TP4 | Keystone 5015 | Via-top exposed pad | GND, 5V, 3V3, 24V |
| TP5–TP7 | Keystone 5015 | Via-top exposed pad | PHASE_A, PHASE_B, PHASE_C |
| TP8–TP10 | Keystone 5015 | Via-top exposed pad | CSA_A, CSA_B, CSA_C |
| TP11 | Keystone 5015 | Via-top exposed pad | nFAULT |

---

## 4. RPi 40-Pin Header Signal Assignment

J1: Samtec SSW-120-01-F-D (2×20, through-hole, low-profile)

| Pin | Signal | Direction | Net | Notes |
|-----|--------|-----------|-----|-------|
| 1 | 3V3_RPi | IN | VDD_RPi | DRV8305 VDD (< 5mA draw) |
| 2 | 5V_RPi | OUT | 5V | Board powers RPi from buck |
| 4 | 5V_RPi | OUT | 5V | Parallel for current capacity |
| 6 | GND | — | GND | |
| 19 | SPI0_MOSI (BCM10) | IN | DRV_SDI | DRV8305 data in |
| 21 | SPI0_MISO (BCM9) | OUT | DRV_SDO | DRV8305 data out |
| 23 | SPI0_SCLK (BCM11) | IN | DRV_SCLK | SPI clock |
| 24 | SPI0_CE0 (BCM8) | IN | DRV_CS | DRV8305 chip select (active low) |
| 26 | SPI0_CE1 (BCM7) | IN | ADC_CS | MCP3204 chip select |
| 11 | BCM17 | OUT | nFAULT | DRV8305 fault (active low, OD) |
| 13 | BCM27 | IN | nSLEEP | Gate driver enable (high = on) |
| 15 | BCM22 | OUT | HALL_A | Hall sensor A |
| 16 | BCM23 | OUT | HALL_B | Hall sensor B |
| 18 | BCM24 | OUT | HALL_C | Hall sensor C |
| 27 | ID_SD (BCM0) | — | EEPROM_SDA | HAT ID EEPROM |
| 28 | ID_SC (BCM1) | — | EEPROM_SCL | HAT ID EEPROM |
| 32 | BCM12/PWM0 | IN | PWM_INL1 | Optional: direct PWM to INL1 |
| 33 | BCM13/PWM1 | IN | PWM_INH1 | Optional: direct PWM to INH1 |
| 9,14,20,25,30,34,39 | GND | — | GND | Ground pins |

**ESD protection:** PRTR5V0U2X (NXP, dual rail-to-rail ESD, 5.5V, SC-88A) on SPI lines (SDI, SDO, SCLK, CS). One device protects 2 lines; use 3 devices for all SPI + nFAULT/nSLEEP.

---

## 5. Thermal Analysis

| Component | Pd (typ) | Pd (max) | θja | ΔTj (typ) | Tj max |
|-----------|----------|----------|-----|-----------|--------|
| Q1–Q3 (HS FETs) | 83mW each | 200mW | 50°C/W (board) | 10°C | 70+10=80°C |
| Q4–Q6 (LS FETs) | 83mW each | 200mW | 50°C/W (board) | 10°C | 80°C |
| DRV8305 | 500mW | 900mW | 14.5°C/W (θjb) | 13°C | 83°C |
| LMR33630 | 400mW | 600mW | 45°C/W (θja) | 18°C | 88°C |
| R18–R20 shunts | 125mW each | 300mW | N/A | — | 80°C rated |

Thermal vias: minimum 9× 0.3mm diameter under each FET and DRV8305 pad, tied to inner GND plane.

---

## 6. Protection Summary

| Hazard | Mechanism | Component |
|--------|-----------|-----------|
| Reverse polarity input | P-ch MOSFET gate-off | Q_RPol + LTC4359 |
| Input transient / motor kickback | TVS clamp | TVS1 (SMAJ36A) |
| Overcurrent (motor) | DRV8305 OCP latch, 8A threshold | DRV8305 internal |
| Short circuit (phase) | OCP + hardware OVP fuse | DRV8305 + F1 |
| Shoot-through | Programmable dead time (200ns) | DRV8305 register |
| Gate drive undervoltage | UVLO (DRV8305 PVDD < 8V) | DRV8305 internal |
| Logic undervoltage | UVLO (DRV8305 VDD < 2.5V) | DRV8305 internal |
| Thermal shutdown | TSD at Tj=170°C | DRV8305 internal |
| ESD on RPi GPIOs | Rail-to-rail ESD diodes | PRTR5V0U2X |
| Overload (logic 5V) | Foldback current limit | LMR33630 OCP |
| Fuse fail-safe | 7.5A fast-blow in series | F1 |

---

## 7. PCB Dimensions & Mounting

Per RPi HAT Mechanical specification (https://github.com/raspberrypi/hats):

- PCB: **65.0 × 56.5mm**, 4-layer, 1.6mm
- Mounting holes: **4× M2.5** plated, at (3.5, 3.5), (61.5, 3.5), (3.5, 52.5), (61.5, 52.5) mm from PCB bottom-left
- 40-pin header: Pin 1 at (32.5mm from left, 2.5mm from bottom), 2.54mm pitch, 2×20
- Connector clearance: HAT must clear RPi USB, Ethernet on bottom side. Minimum bottom-side component height: check against Pi model stackup height.
- Component keep-out: 3mm inside all PCB edges (except connector mounting areas)

---

## 8. Software Interface (Linux / RPi)

Driver model: SPI device + GPIO  
DRV8305 SPI: `/dev/spidev0.0` (CE0), mode 1, 1–4 MHz  
MCP3204 SPI: `/dev/spidev0.1` (CE1), mode 0, 1 MHz  
nFAULT GPIO: BCM17, edge-triggered interrupt (falling edge = fault)  
nSLEEP GPIO: BCM27, active-high output  
HALL A/B/C: BCM 22/23/24, input with pull-up

Recommended library: `spidev` (Python) or `wiringpi` (C) for bringup.  
Motor control: SimpleFOC (Arduino-compatible) or custom RPi implementation.

---

## 9. Design Review Checklist

- [ ] DRV8305 bootstrap caps rated ≥50V (PVDD + 20%)
- [ ] All FET Vds_max ≥ 1.5× PVDD = 36V (BSZ033N04LSI = 40V ✓)
- [ ] Shunt resistors: Kelvin connections verified in layout
- [ ] Buck inductor DC current rating ≥ 1.5× max output current (4A ≥ 3A ✓)
- [ ] Fuse current rating ≤ 3× motor rated current (7.5A ≤ 15A ✓)
- [ ] TVS clamping voltage < FET Vds_max (36V < 40V ✓)
- [ ] Bootstrap diode reverse breakdown ≥ PVDD (BAT54S = 30V — INSUFFICIENT at 24V + transients — replace with MBRS130LT3G or similar 40V Schottky)
- [ ] HAT EEPROM programmed before first boot
- [ ] RPi 5V feedback: ensure buck cannot backfeed RPi USB power if both powered
- [ ] Dead-time ≥ MOSFET turn-off time (40ns dead time vs ~20ns FET fall — ✓)
