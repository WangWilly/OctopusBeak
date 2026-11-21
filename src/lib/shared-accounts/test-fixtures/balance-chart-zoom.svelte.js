import { mount } from "svelte";
import SnapshotSparkline from "$lib/overview/components/SnapshotSparkline.svelte";
import StackedBalanceChart from "$lib/shared-accounts/components/StackedBalanceChart.svelte";
import AccountHistoryModal from "$lib/shared-accounts/components/AccountHistoryModal.svelte";
import "../../../app.css";

export function render(chart, initialProps) {
  const props = $state(initialProps);
  const components = { snapshot: SnapshotSparkline, stacked: StackedBalanceChart, history: AccountHistoryModal };
  mount(components[chart], { target: document.body, props });
  return (next) => Object.assign(props, next);
}
