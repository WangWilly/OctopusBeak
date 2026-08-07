<script lang="ts">
  import { forceCollide, forceX, forceY, type Simulation } from "d3-force";
  import { ForceSimulation } from "layerchart/svg";
  import { onDestroy, onMount } from "svelte";

  import {
    rasterizeText,
    resolveTextParticleBudget,
    type TextParticle,
  } from "./rasterize-text.ts";

  export let text: string;
  export let reducedMotion = false;

  let host: HTMLDivElement;
  let particles: TextParticle[] = [];
  let simulation: Simulation<TextParticle, undefined> | null = null;
  let stopped = true;
  let coolTimer: ReturnType<typeof setTimeout> | undefined;
  let ambientTimer: ReturnType<typeof setInterval> | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let rasterWidth = 600;
  let rasterHeight = 180;
  let mounted = false;
  let rebuildSignature = "";
  let ambientPhase = 0;

  function animatedTargetX(datum: TextParticle) {
    return datum.targetX + Math.sin(ambientPhase + datum.targetY * 0.045) * 1.4;
  }

  function animatedTargetY(datum: TextParticle) {
    return datum.targetY + Math.cos(ambientPhase + datum.targetX * 0.035) * 1.1;
  }

  $: forces = {
    x: forceX<TextParticle>(animatedTargetX).strength(0.24),
    y: forceY<TextParticle>(animatedTargetY).strength(0.24),
    collide: forceCollide<TextParticle>(1.4).strength(0.5),
  };

  $: if (mounted && host) {
    const signature = `${text}:${reducedMotion}`;
    if (signature !== rebuildSignature) {
      rebuildSignature = signature;
      rebuild(host.clientWidth, host.clientHeight);
    }
  }

  function rebuild(width: number, height: number) {
    if (reducedMotion || typeof document === "undefined") return;
    rasterWidth = Math.max(260, Math.min(720, Math.round(width)));
    rasterHeight = Math.max(120, Math.round(height));
    particles = rasterizeText(text, {
      width: rasterWidth,
      height: rasterHeight,
      font: `800 ${Math.round(rasterHeight * 0.82)}px Inter, ui-sans-serif, system-ui, sans-serif`,
      maxPoints: Math.min(
        text.length > 4 ? 520 : 420,
        resolveTextParticleBudget(rasterWidth, window.devicePixelRatio),
      ),
      seed: text === "歡迎" ? 0x6f63747a : 0x6f637465,
    });
    stopped = !shouldRun();
    if (simulation) {
      simulation.nodes(particles);
      syncSimulationActivity();
    }
  }

  function shouldRun() {
    return !reducedMotion && !document.hidden && document.hasFocus();
  }

  function syncSimulationActivity() {
    if (!simulation) return;
    if (shouldRun()) {
      stopped = false;
      simulation.alpha(Math.max(simulation.alpha(), 0.16)).alphaTarget(0.035).restart();
    } else {
      simulation.alphaTarget(0);
      simulation.stop();
      stopped = true;
    }
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
    coolTimer = setTimeout(syncSimulationActivity, 220);
  }

  onMount(() => {
    if (reducedMotion) return;
    mounted = true;
    rebuildSignature = `${text}:${reducedMotion}`;
    rebuild(host.clientWidth, host.clientHeight);
    resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? host.clientWidth;
      const nextHeight = entry?.contentRect.height ?? host.clientHeight;
      if (Math.abs(nextWidth - rasterWidth) > 40 || Math.abs(nextHeight - rasterHeight) > 10) {
        rebuild(nextWidth, nextHeight);
      }
    });
    resizeObserver.observe(host);
    window.addEventListener("focus", syncSimulationActivity);
    window.addEventListener("blur", syncSimulationActivity);
    document.addEventListener("visibilitychange", syncSimulationActivity);
    ambientTimer = setInterval(() => {
      if (!simulation || !shouldRun()) return;
      ambientPhase += 0.16;
      simulation.alpha(Math.max(simulation.alpha(), 0.055)).restart();
    }, 180);
  });

  onDestroy(() => {
    mounted = false;
    clearTimeout(coolTimer);
    clearInterval(ambientTimer);
    resizeObserver?.disconnect();
    window.removeEventListener("focus", syncSimulationActivity);
    window.removeEventListener("blur", syncSimulationActivity);
    document.removeEventListener("visibilitychange", syncSimulationActivity);
    simulation?.stop();
  });
</script>

<div
  class="force-text"
  class:reduced={reducedMotion}
  role="presentation"
  bind:this={host}
  onpointermove={handlePointerMove}
  onpointerleave={syncSimulationActivity}
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
        onStart={({ simulation: nextSimulation }) => {
          simulation = nextSimulation;
          syncSimulationActivity();
        }}
      >
        {#snippet children({ nodes })}
          <svg viewBox={`0 0 ${rasterWidth} ${rasterHeight}`} role="presentation">
            {#each nodes as node}
              <circle cx={node.x ?? node.targetX} cy={node.y ?? node.targetY} r="1.65"></circle>
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
    height: 100%;
    place-items: center;
    color: #071f4a;
  }

  h1 {
    z-index: 1;
    margin: 0;
    font-size: clamp(4.5rem, 10vw, 8.5rem);
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
    height: 100%;
  }
</style>
