# Overview Sankey Prototype and Data Flow

## Goal

Add a full-width Sankey card at the bottom of Overview to explain how the current portfolio is distributed. The first delivery uses deterministic mock data; the second replaces that data with current account, position, and exchange-rate data.

## Prototype

- Use LayerChart `Chart`, `Layer`, `Sankey`, `Link`, `Group`, `Rect`, `Text`, and `Tooltip`.
- Render one fixed overview, without node selection or drill-down.
- Render four left-to-right levels:
  1. Assets and liabilities
  2. Asset kinds (bank, fund, brokerage, crypto, foreign) and liability kinds (credit card, loan)
  3. Account names
  4. Asset position names, where positions exist
- Bank, foreign-currency, credit-card, and loan accounts terminate at their account node.
- Use cool blue-green hues for asset nodes and links; use warm clay-red hues for liabilities.
- On node hover, show its label, TWD amount, incoming nodes, and outgoing nodes. On link hover, show source, target, and TWD amount.
- Give the card a fixed desktop-height chart with responsive width and an accessible text summary of every flow.

## Production Data

- Extend the Overview DTO and loader with current account positions and their current converted TWD values.
- Account value links use the account's current book value. Position links use position values and sum to their account value.
- Convert every non-TWD value using the current exchange-rate set. If any included value cannot be converted with a current rate, omit the entire Sankey card.
- Keep the Sankey absent, rather than showing partial totals or stale-rate values.

## Validation

- Unit-test graph construction: hierarchy, terminal accounts, converted values, and omission for missing rates.
- Component check: the card uses LayerChart Sankey and renders the specified tooltip labels.
- Verify the Overview layout at desktop and narrow widths, including a graph with many account labels.
