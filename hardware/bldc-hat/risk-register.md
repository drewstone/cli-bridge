# Risk Register — bldc-hat Rev A

Each risk has: description, likelihood (H/M/L), impact (H/M/L), mitigation, and owner.

---

## Electrical Risks

### R-E1: Bootstrap diode reverse breakdown at 24V
**Likelihood:** H  **Impact:** H  
**Description:** BAT54S has Vr = 30V. With 24V bus and switching transients (potentially 36V+), the bootstrap diode may avalanche on every cycle, degrading and eventually failing — blowing the bootstrap cap and destroying the high-side FET.  
**Mitigation:** **Resolved in BOM Rev A:** replaced BAT54S with BAT54AWT1G (40V rating). Verify that the chosen diode's Vr > max PVDD transient. Add SMAJ36A TVS to clamp transients.  
**Status:** Mitigated — verify transients on oscilloscope at first power-up

### R-E2: Shunt resistor Kelvin connection failure
**Likelihood:** M  **Impact:** H  
**Description:** If current-sense traces share vias or bends with power-current traces, parasitic resistance/inductance generates incorrect CSA readings. Overcurrent protection trips at wrong threshold; motor runs in overcurrent without latching.  
**Mitigation:** 4-terminal (Kelvin) footprint on all three shunts. SP/SM traces ≤ 0.15mm width, routed as a differential pair directly from shunt pads to DRV8305 CSA± pins. No via under or between shunt sense pins. Verify with Kelvin resistance measurement at bring-up.  
**Owner:** Layout engineer — flag for design review

### R-E3: Buck regulator unstable — insufficient output capacitance
**Likelihood:** M  **Impact:** M  
**Description:** LMR33630 minimum Cout for stability depends on operating point. With 44µF total and light load, loop may ring. X5R caps derate ≥ 50% at 5V Vrated — 22µF rated @ 10V at 5V output = ~15µF effective. Total effective ~30µF.  
**Mitigation:** Use 25V-rated X5R if available (less derating), or add a third 22µF/10V cap. Measure output ripple (< 50mV expected at 3A) at first build. If unstable, increase Cout or adjust Rt for lower frequency.  
**Status:** Monitor at bringup

### R-E4: RPi 5V backfeed conflict
**Likelihood:** M  **Impact:** M  
**Description:** If RPi is also powered via USB, both the USB 5V and the HAT's buck 5V drive the same 5V rail. The USB regulator and buck will fight; the lower-voltage source clamps and one regulator may latch off or overheat.  
**Mitigation:** HAT 5V output has a Schottky diode (MBRD0540T1G, 40V 500mA) in series before the RPi 5V header pin, OR use an active OR circuit (LTC4413 or dual ideal diode). For prototype: assume USB is NOT plugged in when HAT powers RPi. Add silkscreen warning. Permanent fix in Rev B.  
**Owner:** Schematic designer — add OR diode before tapeout

### R-E5: DRV8305 PVDD UVLO false trigger at motor startup
**Likelihood:** L  **Impact:** M  
**Description:** Large inrush current at motor startup causes voltage sag on PVDD bus. If sag dips below 8V UVLO threshold, DRV8305 latches fault mid-commutation, causing sudden motor stop (harmful in motion applications).  
**Mitigation:** Adequate bulk capacitance (4× 100µF = 400µF) with low-ESR caps limits sag. Size PSU current limit ≥ 2× motor rated current. If sag is observed, add soft-start in software (current ramp), or increase bulk cap to 800µF+.

### R-E6: FET body diode conduction during dead time
**Likelihood:** L  **Impact:** L  
**Description:** During 200ns dead time, phase current freewheels through FET body diode (slower, higher Vf than external Schottky). Causes extra heat; at 40kHz PWM this is 1.6% of cycle in diode conduction.  
**Mitigation:** With BSZ033N04LSI body diode Vf ≈ 0.7V at 5A, dead-time loss ≈ 5A × 0.7V × 0.016 = 56mW total. Acceptable. If overheating, add external Schottky (B560C-13-F) in parallel with each low-side FET or reduce dead time to 80ns (check for shoot-through risk first).

---

## Mechanical Risks

### R-M1: Insufficient height clearance between HAT and RPi
**Likelihood:** M  **Impact:** H  
**Description:** Bottom-side components (electrolytics, XT30 connector) may contact RPi USB/Ethernet connectors. RPi 4B top-side tallest components are ~16mm (USB 3.0 ports).  
**Mitigation:** Use 12mm M2.5 standoffs (standard HAT clearance = ~12mm). Verify all bottom-side component heights ≤ 10mm. Electrolytic caps (12.5mm height) must be placed in HAT "safe zone" — see RPi HAT mechanical spec. Lay electrolytics on side, or use surface-mount polymer caps as alternative.  
**Owner:** Layout engineer — include 3D step model check

### R-M2: XT30 connector footprint stress
**Likelihood:** M  **Impact:** M  
**Description:** XT30PW-M is a PCB-mount version but still sees significant mating force. Without strain relief or additional mechanical anchor, repeated plug/unplug may crack solder joints on PCB.  
**Mitigation:** Use XT30PW-M (the PCB-mount version with mounting pegs). Ensure pegs are soldered. Add "Do not mate under power" label. Consider switching to screw terminal (Phoenix Contact 1984617) for prototype if connector durability not required.

### R-M3: HAT EEPROM not programmed before first boot
**Likelihood:** H  **Impact:** L  
**Description:** RPi HAT detection depends on reading EEPROM on I2C ID bus. Unprogrammed EEPROM causes "hat: failed to read EEPROM" error in dmesg, blocking automatic device tree overlay loading.  
**Mitigation:** EEPROM write-protect jumper (R22) is DNP by default. Program with `eepromutils` before first deploy. Include programming procedure in bring-up checklist. Log board serial numbers with programmed status.

---

## Manufacturing Risks

### R-F1: HTSSOP-38 solder bridges during assembly
**Likelihood:** M  **Impact:** H  
**Description:** DRV8305 HTSSOP-38 has 0.65mm pitch. Solder bridges between adjacent pins cause shoot-through, gate drive errors, or permanent IC damage.  
**Mitigation:** ENIG finish (per spec). Type 3 or 4 solder paste. Stencil thickness 0.10mm for this area. Visual inspection under 40× magnification post-reflow. Automated optical inspection (AOI) mandatory for production run. X-ray inspection for PowerPAD void check (target < 25% void per IPC-7093).

### R-F2: Component shortage — DRV8305NDCA
**Likelihood:** M  **Impact:** H  
**Description:** TI gate drivers have experienced supply chain disruptions. DRV8305 may be on long lead time (12–52 weeks).  
**Mitigation:** Check Mouser/DigiKey stock before board layout begins. If unavailable: **alternative pin-compatible** gate drivers are **NOT drop-in** (DRV8305 has unique SPI register map). Alternative: DRV8305EDCA (OTP preprogrammed version, fixed config — remove SPI config code), or redesign for DRV8353RS (integrated FETs, different footprint, requires rework).  
**Owner:** Drew — check stock now, order 10+ pcs before layout

### R-F3: X5R capacitors derate at voltage
**Likelihood:** M  **Impact:** L  
**Description:** X5R dielectric loses 50–70% capacitance at rated voltage. 22µF/10V cap at 5V output = ~14µF effective. For LDO bypass, 10µF/10V at 3.3V ≈ 7µF effective.  
**Mitigation:** Uprate all bulk caps: use 25V rating where possible. For 5V rail: 22µF/16V X5R retains ~16µF at 5V — this is the correct choice. Update BOM if needed. Use Murata SimSurfing to verify effective capacitance.

### R-F4: Paste stencil misalignment on large thermal pads
**Likelihood:** M  **Impact:** M  
**Description:** Misaligned stencil leaves insufficient paste under DRV8305 PowerPAD, resulting in poor thermal contact and hot spots.  
**Mitigation:** Use IPC-7525 stencil design (grid of openings, 50% coverage) on thermal pads. Order SMD-alignment fiducials (3× 1mm pads) on PCB. Use manual stencil alignment jig for prototype run.

---

## Schedule Risks

### R-S1: Layout complexity extends timeline
**Likelihood:** M  **Impact:** M  
**Description:** 4-layer HAT with HTSSOP-38, 6 FETs, and tight current paths requires experienced layout engineer. Novice layout may require 2–3 spins to pass design review. At 1.5× novice pace: 3 weeks for initial layout vs. 2 weeks for senior engineer.  
**Mitigation:** Assign layout to engineer with motor driver PCB experience. Use DRV8305 EVM reference layout as starting point (TI TIDA-00472 or BOOSTXL-DRV8305EVM). Block explicit time for Kelvin routing and dead-time verification.  
**Estimated timeline:**
- Schematic capture: 3 days (engineer)
- Layout: 10–15 days (including review cycles)
- Fab + assembly (JLCPCB expedite): 10 days
- Bring-up: 5 days
- **Total to working prototype: ~5–6 weeks**

### R-S2: Fab minimum order vs. prototype quantity
**Likelihood:** L  **Impact:** L  
**Description:** JLCPCB 4-layer minimum is 5 PCBs. For component procurement, order 2× BOM quantity to cover reflow failures.  
**Mitigation:** Order 10 bare PCBs, 2× BOM for critical/expensive parts (U1 DRV8305, Q1–Q6 FETs, L1 inductor). Budget line item included in BOM.
