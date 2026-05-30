# PCB Fabrication & Assembly Requirements — bldc-hat Rev A

## 1. Governing Standards

| Standard | Scope |
|----------|-------|
| IPC-A-610G | Acceptability — **Class 2** |
| IPC-2221B | Generic design |
| IPC-7351B | Land pattern conventions |
| IPC-2152 | Current-carrying capacity |
| IPC-4101C | FR-4 laminate |
| RPi HAT spec | Mechanical compliance |

---

## 2. Board Stackup

**4-layer, 1.6mm total thickness ±0.15mm**

| Layer | Designation | Copper | Function |
|-------|-------------|--------|----------|
| L1 (top) | Signal + Power | 1oz (35µm) | Components, signal traces, 5V/3V3 fills |
| — | Prepreg 7628 | — | 0.21mm |
| L2 | GND | 1oz (35µm) | **Solid GND plane — no splits** |
| — | Core FR-4 | — | 1.0mm |
| L3 | PWR | 1oz (35µm) | PVDD (24V) fill + signal routing |
| — | Prepreg 7628 | — | 0.21mm |
| L4 (bottom) | Signal + Thermal | 1oz (35µm) | Motor phase power pours, FET thermal relief |

**Laminate:** IPC-4101C /21 FR-4, Tg ≥ 150°C (Tg170 preferred for lead-free reflow)  
**Copper foil:** ED copper, IPC-4562 Grade E  

---

## 3. Design Rules

### 3.1 Clearances

All clearances are minimums; use larger wherever possible.

| Net Class | Condition | Min Clearance | Used |
|-----------|-----------|---------------|------|
| Signal–Signal (< 5V) | Internal | 0.10mm | 0.15mm |
| Signal–Signal (< 5V) | External | 0.10mm | 0.15mm |
| 24V–GND | Internal, with conformal coat | 0.13mm | 0.25mm |
| 24V–GND | External, uncoated | 0.50mm | 1.0mm |
| 24V–Signal | External | 0.50mm | 0.8mm |
| 24V–Board edge | — | 2.0mm | 3.0mm |
| Motor phase pours | External | 1.0mm | 1.5mm |

**Creepage** (per IPC-2221B, Condition B2, pollution degree 2):  
- 24V uncoated external: ≥ 0.5mm creepage distance between PVDD and signal copper  
- Physical gaps in solder mask between motor phase areas and logic areas: **minimum 0.3mm gap in SM opening**

### 3.2 Trace Widths

Calculated per IPC-2152 for 35µm (1oz) copper, ΔT = 10°C, ambient = 40°C.

| Current | Layer | IPC-2152 min | Design rule |
|---------|-------|--------------|-------------|
| 5A | External | 0.75mm | **2.0mm** |
| 5A | Internal | 1.2mm | **2.0mm** (or copper pour) |
| 3A (5V rail) | External | 0.45mm | **1.0mm** |
| 1A (logic) | External | 0.15mm | **0.25mm** |
| Signal | External | — | **0.15mm min** |

**Motor phase traces (PHASE_A/B/C, PVDD):** Use copper pours on L1+L4 connected by stitching vias. Target minimum effective width equivalent to 2mm after thermal relief cuts.

### 3.3 Via Specifications

| Via Type | Drill | Pad | Use |
|----------|-------|-----|-----|
| Signal | 0.3mm | 0.6mm | General signal nets |
| Power | 0.5mm | 1.0mm | 5V, 3.3V, small PVDD branches |
| PVDD / phase | 0.8mm | 1.4mm | Motor phase current paths |
| Thermal (FET) | 0.3mm | 0.6mm | Thermal vias under FET thermal pads |

Minimum annular ring: 0.15mm (for all via types)  
Via aspect ratio: max 8:1 (1.6mm board / 0.2mm drill = 8, so 0.2mm is absolute minimum drill)  
Tenting: signal vias tented both sides; power/thermal vias open on copper side, tented on component side

### 3.4 Thermal Vias

- DRV8305 PowerPAD (10.9mm² exposed pad): **minimum 16× 0.3mm vias** in 4×4 array, 1.2mm pitch
- BSZ033N04LSI thermal pad (3×3mm): **minimum 9× 0.3mm vias** in 3×3 array, 0.9mm pitch
- LMR33630 exposed pad: **minimum 4× 0.3mm vias** in 2×2 array
- All thermal vias connect L1→L2 (GND plane) for heat spreading

### 3.5 Impedance Control

No controlled impedance required for this design (SPI ≤ 4MHz, ≤ 50mm trace length).  
If SPI traces exceed 100mm, add 33Ω series termination at source.

---

## 4. Land Patterns

Per IPC-7351B, density level B (most common SMD parts):

| Package | IPC reference | Courtyard extra |
|---------|---------------|-----------------|
| HTSSOP-38 (DRV8305) | SOP65P640X120-38N | 0.25mm |
| TDSON-8 (BSZ033N04LSI) | SON65P300X300X100-9N | 0.25mm |
| WSON-8 (LMR33630) | SON65P200X200X80-9N | 0.25mm |
| SOT-25 | SOT95P280X145-5N | 0.25mm |
| SOT-23-5 (EEPROM) | SOT95P280X145-5N | 0.25mm |
| SOIC-14 (MCP3204) | SOP65P780X200-14N | 0.25mm |
| 0402 passive | RESC1005X40N | 0.15mm |
| 0805 passive | RESC2012X65N | 0.20mm |
| 2512 shunt | RESC6432X56N | 0.25mm |
| SMA (TVS) | SMA | 0.25mm |

**TDSON-8 (BSZ033N04LSI) thermal pad:** exposed bottom, 2.3×2.8mm. Do not solder-mask over pad. Include thermal vias.  
**HTSSOP-38 PowerPAD:** 7.8×4.4mm exposed pad on bottom of IC. Vias under pad may be covered with paste. Check DRV8305 datasheet Figure 26.

---

## 5. Silkscreen & Markings

- Reference designators: min 1.0mm text height, 0.15mm stroke
- No reference designators under components
- Polarity markers on all capacitors, diodes, transistors
- Pin 1 indicator on all ICs (triangle or dot in silkscreen)
- Board title, revision, date in silkscreen on bottom layer
- IPC Class 2 marking: "IPC-A-610G CL2" on bottom silkscreen
- UL marking if needed for end product certification

---

## 6. Solder Mask

- Color: Green (matte preferred, not gloss)
- Material: Liquid Photo-Imageable (LPI) both sides
- Expansion over pad: 0.05mm (manufacturer default is acceptable)
- Solder mask between HTSSOP-38 pads: minimum 0.10mm dam (verify fab capability for 0.65mm pitch)
- PVDD pours and motor phase areas: solder mask opening for copper pour heatsinking (no mask over pour)
- Thermal pad openings: grid pattern per IPC-7093, 50% paste coverage for big pads

---

## 7. Surface Finish

**ENIG** (Electroless Nickel Immersion Gold)  
- Gold thickness: 0.05–0.10µm (IPC-4552 Type II)  
- Nickel thickness: 3–6µm  
- Reason: required for HTSSOP-38 (0.65mm pitch) and WSON/SON fine-pitch soldering; better shelf life than HASL  

Do NOT use HASL (warped pads on fine-pitch), OSP (shorter shelf life), or hard gold (cost).

---

## 8. Solder Paste

- Type: SAC305 (Sn96.5Ag3Cu0.5), no-clean Type 3 or Type 4
- Stencil thickness: 0.12mm for most pads, 0.10mm for HTSSOP-38 pitch
- Stencil aperture reduction on big thermal pads: 20% per axis (per IPC-7525)
- DRV8305 PowerPAD aperture: split into grid per TI recommended stencil pattern

---

## 9. Assembly Notes

**Reflow profile** (SAC305, IPC-7711/7721):
- Preheat: 150–180°C for 60–90 s
- Soak: 180–200°C for 60–90 s
- Peak: 245–250°C, ≤ 10 s above 235°C
- Cooling: ≤ 4°C/s from peak to 100°C

**Component placement constraints:**
- Place LMR33630 close to its input/output caps; minimize switching loop perimeter (Cin, Cout, and inductor within 5mm of IC)
- DRV8305: place bootstrap caps within 3mm of bootstrap pins (BST_A/B/C); shunt resistors within 10mm
- Gate resistors: within 3mm of corresponding FET gate pins
- Electrolytic caps: sufficient clearance from hot components (FETs, DRV8305) — min 5mm from thermal pad edges
- XT30 connector: do not place tall components within 10mm on both sides (routing space and airflow)

**Component orientation:** All ICs consistent orientation (pin 1 toward top-left or as per board coordinate system). Capacitors and resistors consistent: 0402 = horizontal preferred.

**DNP (Do Not Populate):** U3 (AP2112K), U4 (MCP3204), J5 (debug header), R22 (EEPROM WP) are DNP on initial prototype. Verify functionality before populating.

---

## 10. Fabrication Files (Gerber Package)

Submit the following to fab:

```
bldc-hat-rev-a/
  gerbers/
    bldc-hat.GTL    Top copper
    bldc-hat.GBL    Bottom copper
    bldc-hat.G2L    Inner layer 2 (GND)
    bldc-hat.G3L    Inner layer 3 (PWR)
    bldc-hat.GTS    Top soldermask
    bldc-hat.GBS    Bottom soldermask
    bldc-hat.GTO    Top silkscreen
    bldc-hat.GBO    Bottom silkscreen
    bldc-hat.GKO    Board outline (keepout)
    bldc-hat.DRL    Excellon drill file (through-hole)
    bldc-hat.DRL    Excellon drill file (vias if separate)
  assembly/
    bldc-hat-bom.csv           BOM in JLC/PCBWay format
    bldc-hat-cpl-top.csv       Centroid/placement file (top side)
    bldc-hat-cpl-bottom.csv    Centroid/placement file (bottom side)
  bldc-hat-fabrication-notes.pdf
```

**Fab checklist before submission:**
- [ ] Run DRC in KiCad, zero errors
- [ ] Check board outline is on Edge.Cuts layer only
- [ ] Verify Gerber in Gerber viewer (gerbv or JLC viewer) before submitting
- [ ] Confirm drill files: through-hole and via sizes match design intent
- [ ] BOM: all LCSC part numbers verified in stock on jlcpcb.com before ordering
- [ ] Centroid file: rotation angles verified (JLCPCB often needs +90° or +180° correction for certain packages)
- [ ] Stencil: order laser-cut stainless steel stencil with PCBs (saves cost)

---

## 11. Electrical Test Requirements (post-assembly)

Before powering with 24V:
1. Visual inspection: all components placed, no solder bridges on HTSSOP-38, no shorts between motor phase pads
2. Resistance check: PVDD to GND ≥ 1kΩ (< 1kΩ indicates solder bridge on FET drain-source or electrolytic reversed)
3. Resistance check: 5V to GND ≥ 10kΩ cold
4. Apply 5V via RPi header (no motor power): verify 3.3V appears on U1 VDD (pin 3), LED1 illuminates
5. Apply 24V at 1A current limit: verify no current draw (Q_RPol protecting) — wait, this should conduct correctly. Verify 24V on PVDD bus, 5V on buck output, < 100mA draw in idle state
6. Run SPI loopback test: verify DRV8305 register read-back (STAT_REG_1 = 0x0000 in healthy state)
7. Verify DRV8305 responds to nSLEEP assertion; verify nFAULT stays high when no fault
8. Apply motor phases with oscilloscope: verify 3-phase PWM at correct frequency, correct dead time (200ns), no shoot-through
