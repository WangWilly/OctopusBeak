<script lang="ts">
  import { forceCollide, forceX, forceY, type Simulation } from "d3-force";
  import { ForceSimulation } from "layerchart/svg";
  import { onDestroy, onMount } from "svelte";

  import { rasterizeText, type TextParticle } from "./rasterize-text.ts";

  export let text: string;
  export let reducedMotion = false;

  let host: HTMLDivElement;
  let particles: TextParticle[] = [];
  let simulation: Simulation<TextParticle, undefined> | null = null;
  let stopped = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let coolTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let rasterWidth = 600;
  const rasterHeight = 150;

  $: forces = {
    x: forceX<TextParticle>((datum) => datum.targetX).strength(0.16),
    y: forceY<TextParticle>((datum) => datum.targetY).strength(0.16),
    collide: forceCollide<TextParticle>(1.25).strength(0.45),
  };

  function rebuild(width: number) {
    if (reducedMotion || typeof document === "undefined") return;
    rasterWidth = Math.max(260, Math.min(720, Math.round(width)));
    particles = rasterizeText(text, {
      width: rasterWidth,
      height: rasterHeight,
      font: "800 76px Inter, ui-sans-serif, system-ui, sans-serif",
      maxPoints: Math.min(900, Math.max(360, Math.round(rasterWidth * 1.15))),
      seed: text === "歡迎" ? 0x6f63747a : 0x6f637465,
    });
    stopped = false;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      simulation?.alphaTarget(0);
      simulation?.stop();
      stopped = true;
    }, 1_200);
  }

  function handlePointerMove(event: PointerEvent) {
    if (reducedMotion || !simulation) return;
    const rect = host.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * rasterWidth;
    const y = (event.clientY - rect.top) / rect.height * rasterHeight;
    for (const particle of simulation.nodes()) {
      const dx = (particle.x ?? particle.targetX) - x;
      const dy = (particle.y ?? particle.targetY) - y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < 58) {
        const strength = (1 - distance / 58) * 1.4;
        particle.vx = (particle.vx ?? 0) + dx / distance * strength;
        particle.vy = (particle.vy ?? 0) + dy / distance * strength;
      }
    }
    stopped = false;
    simulation.alpha(0.18).alphaTarget(0.03).restart();
    clearTimeout(coolTimer);
    coolTimer = setTimeout(() => {
      simulation?.alphaTarget(0);
      simulation?.stop();
      stopped = true;
    }, 220);
  }

  onMount(() => {
    if (reducedMotion) return;
    rebuild(host.clientWidth);
    resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? host.clientWidth;
      if (Math.abs(nextWidth - rasterWidth) > 80) rebuild(nextWidth);
    });
    resizeObserver.observe(host);
  });

  onDestroy(() => {
    clearTimeout(settleTimer);
    clearTimeout(coolTimer);
    resizeObserver?.disconnect();
    simulation?.stop();
  });
</script>

<div
  class="force-text"
  class:reduced={reducedMotion}
  role="presentation"
  bind:this={host}
  onpointermove={handlePointerMove}
  onpointerleave={() => simulation?.alphaTarget(0)}
>
  <h1 class:particle-heading={!reducedMotion}>{text}</h1>
  {#if !reducedMotion && particles.length}
    <div class="particle-layer" aria-hidden="true">
      <ForceSimulation
        data={{ nodes: particles }}
        {forces}
        {stopped}
        alphaDecay={0.075}
        alphaMin={0.015}
        velocityDecay={0.38}
        onStart={({ simulation: nextSimulation }) => (simulation = nextSimulation)}
      >
        {#snippet children({ nodes })}
          <svg viewBox={`0 0 ${rasterWidth} ${rasterHeight}`} role="presentation">
            {#each nodes as node}
              <circle cx={node.x ?? node.targetX} cy={node.y ?? node.targetY} r="1.45"></circle>
            {/each}
          </svg>
        {/snippet}
      </ForceSimulation>
    </div>
  {/if}
</div>

<style>
  .force-text {
    position: relative;
    display: grid;
    width: min(720px, 76vw);
    min-height: 150px;
    place-items: center;
    color: #071f4a;
  }

  h1 {
    z-index: 1;
    margin: 0;
    font-size: clamp(3rem, 6vw, 5rem);
    font-weight: 800;
    letter-spacing: -0.055em;
    line-height: 1;
  }

  h1.particle-heading {
    color: transparent;
  }

  .particle-layer,
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  circle {
    fill: #071f4a;
  }

  .reduced {
    min-height: 120px;
  }
</style>
