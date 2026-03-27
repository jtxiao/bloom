# Bloom

**Bloom** is an interactive, drag-and-drop tool for modeling and analyzing device power consumption. Build power trees visually, configure components, define operating states, and instantly see power flow, efficiency, losses, and battery lifetime estimates.

**Live app:** [https://jtxiao.github.io/bloom/](https://jtxiao.github.io/bloom/)

---

## Table of Contents

- [Getting Started](#getting-started)
- [Components](#components)
  - [Power Source](#power-source)
  - [Converter](#converter)
  - [Series Element](#series-element)
  - [Load](#load)
  - [Box](#box)
  - [Text](#text)
- [Canvas Interactions](#canvas-interactions)
- [Connecting Components](#connecting-components)
- [Configuration Panel](#configuration-panel)
  - [SI-Aware Inputs](#si-aware-inputs)
  - [Auxiliary Loads](#auxiliary-loads)
  - [CSV Import](#csv-import)
  - [Graph Digitizer](#graph-digitizer)
- [Power States](#power-states)
- [Vin Scenarios](#vin-scenarios)
- [Analysis Results](#analysis-results)
- [Diagnostics Console](#diagnostics-console)
- [Notes](#notes)
- [Heatmap](#heatmap)
- [Project Management](#project-management)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Running Locally](#running-locally)

---

## Getting Started

1. **Add components** by dragging them from the left sidebar onto the canvas.
2. **Connect components** by dragging from a node's right handle (output) to another node's left handle (input). Current flows left-to-right: Source -> Converter -> Series -> Load.
3. **Configure** each component by clicking on it to open its configuration panel on the right.
4. **View results** by clicking "Details" in the toolbar to open the analysis panel, which shows power flow, efficiency, losses, and battery lifetime.

---

## Components

### Power Source

Represents a power input to the system: a battery, USB supply, or wall adapter.

- **Fixed supply** -- Set a nominal voltage, and optionally min/max voltages for scenario analysis.
- **Battery** -- Two sub-modes:
  - **Simple** -- Define capacity (mAh) vs. temperature in a table.
  - **Detailed** -- Provide full discharge curves (voltage vs. capacity) at different temperatures. Curves can be entered manually, imported from CSV, or traced from a screenshot using the graph digitizer.
- **Internal resistance** (Ri) -- Models voltage droop under load.
- **Cutoff voltage** -- For batteries, the voltage at which the battery is considered depleted.
- **Temperature profile** -- Define what fraction of operating time is spent at each temperature (should sum to 100%).

### Converter

A voltage regulator that converts from one voltage to another.

- **Switching regulator** -- Buck, boost, or buck-boost. Efficiency can be set as:
  - **Flat** -- A single efficiency value applied at all loads.
  - **Curve** -- Efficiency vs. load current, optionally at multiple input voltages. Each Vin tab defines a separate efficiency curve. Points can be entered manually, imported from CSV, or traced from a datasheet screenshot.
- **LDO** -- Linear regulator. Efficiency is determined by Vout/Vin. Bloom will flag a diagnostic warning if the input voltage drops below the output.
- **Quiescent current (Iq)** -- Idle current draw of the regulator itself.
- **Enabled/Disabled** -- A disabled converter and everything downstream of it draws no power.

### Series Element

An inline element in the power path: a load switch, FET, fuse, or diode.

- **Resistor / Rdson** -- Models a resistive drop (I^2 * R loss).
- **Diode** -- Models a fixed forward voltage drop (Vf).
- **Enabled/Disabled** -- A disabled series element (e.g. a load switch that is off) cuts power to everything downstream.

### Load

A current-consuming endpoint.

- **Fixed current** -- Draws a constant current.
- **Current profile** -- A time-varying current waveform defined as a table of (time, current) points. Useful for modeling periodic behavior like a sensor that wakes, transmits, and sleeps. The period of the profile is inferred from the last data point.
- **Resistor** -- Draws current based on V/R.
- **Enabled/Disabled** -- A disabled load draws no current.

### Box

A visual grouping outline with no electrical function. Use it to organize related components on the canvas. Resizable when selected.

### Text

A placeable text label with no electrical function. Double-click to edit. Supports configurable font size and color.

---

## Canvas Interactions

| Action | How |
|---|---|
| **Pan** | Click and drag on empty canvas |
| **Zoom** | Scroll wheel, or use the +/- controls in the bottom-left |
| **Select node** | Click on a node |
| **Multi-select** | Hold Shift and drag a selection rectangle |
| **Move node** | Drag a selected node |
| **Delete** | Select node(s) and press Backspace or Delete |
| **Copy** | Cmd/Ctrl+C (copies selected nodes and their internal edges) |
| **Cut** | Cmd/Ctrl+X |
| **Paste** | Cmd/Ctrl+V (pastes with a slight offset) |
| **Search** | Cmd/Ctrl+F opens the node search overlay |
| **Right-click node** | Opens context menu with "Add note for this node" |

---

## Connecting Components

Drag from the **right handle** (output) of one node to the **left handle** (input) of another. Edges are routed automatically using smart bezier curves.

Rules:
- Each node can have **at most one incoming edge** (one parent).
- **Cycles are not allowed** -- Bloom will show a diagnostic if you attempt to create one.
- Edges display the **live current** flowing through them (in A, mA, or uA), animate when the path is active, and appear dashed/dimmed when the path is disabled.

---

## Configuration Panel

Click any power node to open its configuration panel on the right side of the screen.

Every component type has a **label** field and a **Delete Node** button. The rest of the fields depend on the component type (see [Components](#components) above).

### SI-Aware Inputs

Numeric fields accept SI suffixes for convenience:

| Suffix | Multiplier |
|---|---|
| `p` | 10^-12 (pico) |
| `n` | 10^-9 (nano) |
| `u` or `µ` | 10^-6 (micro) |
| `m` | 10^-3 (milli) |
| `k` or `K` | 10^3 (kilo) |
| `M` | 10^6 (mega) |
| `G` | 10^9 (giga) |

For example, typing `20u` into a current field sets it to 20 uA (0.000020 A).

### Auxiliary Loads

Power sources, converters, and series elements can have **auxiliary loads** -- small current sinks on the component itself (like a feedback resistor divider or indicator LED). Each aux load can be set to:

- **Fixed current** -- A constant current draw.
- **Resistor** -- Current determined by voltage / resistance.

Aux loads can be toggled on/off independently per power state (see [Power States](#power-states)).

### CSV Import

Several data tables support importing from CSV files:

- **Efficiency curves** (converter) -- Columns: load current, efficiency.
- **Discharge curves** (battery) -- Columns: capacity (mAh), voltage.
- **Load profiles** (load) -- Columns: time (s), current (A).

### Graph Digitizer

For efficiency curves and battery discharge curves, you can trace data points directly from a **datasheet screenshot**:

1. Click "Extract from Screenshot" in the configuration panel.
2. Upload an image of the chart from the datasheet.
3. **Calibrate** by clicking two reference points (bottom-left and top-right corners of the plot area) and entering their axis values.
4. **Click along the curve** to trace data points.
5. Use **Undo** to remove the last point, or **Reset** to start over.
6. Click **Apply Points** (requires at least 2 points) to import the traced data.

The digitizer supports optional logarithmic X-axis scaling and configurable axis labels/units depending on context.

---

## Power States

Power states model different operating modes of a device (e.g. Active, Sleep, Transmit). Each state can have:

- **Different load currents** -- Each load's current/profile/resistance is snapshotted per state.
- **Different enabled/disabled settings** -- Converters, series elements, and loads can be independently toggled per state.
- **Different aux load overrides** -- Aux loads can be toggled per state.
- **Fraction of time** -- What percentage of total operating time is spent in each state (should sum to 100%).

To manage power states:

1. **Switch states** using the tabs below the toolbar (e.g. "Active", "Sleep").
2. Click **Manage States** to open the state manager, where you can:
   - Add, rename, copy, or remove states.
   - Set the fraction of time for each state.
3. When you switch to a state, the canvas updates to reflect that state's load settings and enable/disable overrides. Configure loads and toggle switches while in a given state to customize it.

The **Weighted Average** view in the analysis results combines all states based on their time fractions to give overall power consumption and battery life estimates.

---

## Vin Scenarios

If any power source defines **min and/or max voltages** (in addition to nominal), Bloom enables **Vin scenario analysis**:

- Tabs labeled **Min**, **Nom**, **Max** appear below the toolbar.
- Selecting a scenario re-runs the analysis at that input voltage.
- The analysis results panel shows per-scenario breakdowns.
- Node labels on the canvas update to reflect the selected scenario's voltages and currents.

This is useful for understanding worst-case power consumption and efficiency across the input voltage range.

---

## Analysis Results

Open the analysis panel by clicking **Details** in the toolbar.

### Summary Cards

At the top of the panel:

- **Avg Input Power** -- Total power drawn from all sources.
- **Avg Load Power** -- Total power delivered to all loads.
- **Total Loss** -- Power dissipated as heat across all components.
- **System Efficiency** -- Load power / input power.
- **Battery Lifetime** -- Estimated hours of operation (shown when a battery source is present).

### Power Distribution Chart

A donut chart showing how power is distributed across the system: load power, loss in each component, and auxiliary consumption. Small slices are grouped under "Other" for readability.

### Time-Series Charts

- **Power Over Time** -- Step chart of input power vs. load power across the load current profile period. Drag on the chart to zoom into a time range; click "Reset Zoom" to restore.
- **Input Current Over Time** -- Current drawn from the source over the profile period.
- **Battery Voltage / Current vs. Time** -- For battery sources with detailed discharge data, shows voltage and current over the battery's full lifetime in hours.

### Per-Node Table

A table listing every component with columns for:

- **Component name** and **type badge** (SOURCE, SW, LDO, SERIES, DIODE, LOAD, RESISTOR)
- **Input power**, **Output power**, **Aux power**, **Loss**, **Efficiency**

The table respects the selected Vin scenario and power state tab.

---

## Diagnostics Console

A collapsible bar at the bottom of the screen showing warnings and errors from the analysis engine:

- **Errors** (red) -- Critical issues like 0V at an enabled node, or missing battery data.
- **Warnings** (yellow) -- Potential problems like LDO input voltage below output, large voltage drops across series elements, or state time fractions not summing to 100%.
- **Info** (blue) -- Informational notes like low converter efficiency (<70%).

Click any diagnostic row with an associated node to jump to and select that node on the canvas.

---

## Notes

The notes drawer is a slide-out panel for freeform annotations about your design.

- **Open/close** the drawer using the tab on the left edge of the canvas (pencil icon with note count badge).
- Type notes freely. Lines starting with `-` are automatically converted to bullet points.
- **Tag nodes** by typing `@` followed by a node label. An autocomplete dropdown appears as you type. Press Enter or click to insert the tag.
- The **organized view** below the text area groups notes by tagged node. Click a node heading to navigate to that node on the canvas.
- **Right-click** any power node on the canvas and select "Add note for [label]" to quickly create a tagged note.

---

## Heatmap

Toggle heatmap mode from the **Visuals** section in the sidebar. When enabled:

- Nodes are shaded based on their **power loss** (or input power for loads) relative to the highest loss in the tree.
- A color scale appears on the canvas showing the range from 0 to max loss in mW.
- Useful for quickly identifying the biggest power sinks in your design.

---

## Project Management

| Action | How |
|---|---|
| **New project** | Click "New" in the toolbar. If there are unsaved changes, a dialog asks whether to save first. |
| **Save** | Click "Save" or press Cmd/Ctrl+S. If you previously used "Save As" to pick a file, it overwrites that file. Otherwise it saves to browser storage. |
| **Save As** | Click "Save As" to choose a location and filename (.json). |
| **Load** | Click "Load" to open a .json project file. |
| **Rename** | Click the project name in the toolbar to edit it inline. |
| **Auto-save** | Your project is automatically saved to browser local storage as you work (debounced, 1 second after changes). |
| **Auto-restore** | On page load, Bloom restores the last auto-saved project from browser storage. |
| **Undo / Redo** | Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) to redo. Up to 50 history steps. |

Project files are JSON and contain the full state of your power tree: nodes, edges, power states, notes, theme preference, and analysis settings.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Cmd/Ctrl + Y` | Redo (alternative) |
| `Cmd/Ctrl + C` | Copy selected nodes |
| `Cmd/Ctrl + X` | Cut selected nodes |
| `Cmd/Ctrl + V` | Paste |
| `Cmd/Ctrl + S` | Save project |
| `Cmd/Ctrl + F` | Search for a node by name |
| `Cmd/Ctrl + Shift + R` | Manual recalculate (when auto-calc is off) |
| `Backspace` / `Delete` | Delete selected nodes |
| `Shift + Drag` | Multi-select rectangle |

Keyboard shortcuts are suppressed when focus is in a text input, textarea, or select field (except undo/redo, which always work).

---

## Running Locally

```bash
git clone https://github.com/jtxiao/bloom.git
cd bloom
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm run build
npm run preview
```

### Tech Stack

- **React 19** + **TypeScript**
- **React Flow** (@xyflow/react) for the interactive canvas
- **Recharts** for charts and data visualization
- **Vite** for build tooling
- **PapaParse** for CSV parsing
