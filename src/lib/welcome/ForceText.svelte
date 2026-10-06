<script lang="ts">
  import { forceSimulation, forceX, forceY, type Simulation } from "d3-force";
  import { onDestroy, onMount } from "svelte";

  import {
    rasterizeText,
    resolveTextParticleBudget,
    type TextParticle,
  } from "./rasterize-text.ts";

  export let text: string;
  export let reducedMotion = false;

  const FONT_FAMILY = "Inter, ui-sans-serif, system-ui, sans-serif";
  const PARTICLE_COLOR = "#071f4a";

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let particles: TextParticle[] = [];
  let latticeSpacing = 3;
  let simulation: Simulation<TextParticle, undefined> | null = null;
  let coolTimer: ReturnType<typeof setTimeout> | undefined;
  let ambientTimer: ReturnType<typeof setInterval> | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let rasterWidth = 600;
  let rasterHeight = 180;
  let mounted = false;
  let rebuildSignature = "";
  let ambientPhase = 0;

  // The drift stays well under the lattice spacing so strokes never blur together.
  function animatedTargetX(datum: TextParticle) {
    return datum.targetX + Math.sin(ambientPhase + datum.targetY * 0.045) * 0.5;
  }

  function animatedTargetY(datum: TextParticle) {
    return datum.targetY + Math.cos(ambientPhase + datum.targetX * 0.035) * 0.4;
  }

  $: if (mounted && host) {
    const signature = `${text}:${reducedMotion}`;
    if (signature !== rebuildSignature) {
      rebuildSignature = signature;
      rebuild(host.clientWidth, host.clientHeight);
    }
  }

  function rebuild(width: number, height: number) {
    if (reducedMotion || typeof document === "undefined" || !canvas) return;
    rasterWidth = Math.max(260, Math.min(720, Math.round(width)));
    rasterHeight = Math.max(120, Math.round(height));
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rasterWidth * pixelRatio);
    canvas.height = Math.round(rasterHeight * pixelRatio);
    ({ spacing: latticeSpacing, particles } = rasterizeText(text, {
      width: rasterWidth,
      height: rasterHeight,
      fontFamily: FONT_FAMILY,
      fontWeight: 700,
      maxPoints: resolveTextParticleBudget(rasterWidth, pixelRatio),
      seed: text === "歡迎" ? 0x6f63747a : 0x6f637465,
    }));
    simulation?.stop();
    simulation = forceSimulation(particles)
      .alphaDecay(0.075)
      .alphaMin(0.015)
      .velocityDecay(0.38)
      .force("x", forceX<TextParticle>(animatedTargetX).strength(0.24))
      .force("y", forceY<TextParticle>(animatedTargetY).strength(0.24))
      .on("tick", draw)
      .stop();
    if (!shouldRun()) {
      for (const particle of particles) {
        particle.x = particle.targetX;
        particle.y = particle.targetY;
      }
    }
    draw();
    syncSimulationActivity();
  }

  function draw() {
    const context = canvas?.getContext("2d");
    if (!context) return;
    const radius = latticeSpacing * 0.46;
    context.setTransform(canvas.width / rasterWidth, 0, 0, canvas.height / rasterHeight, 0, 0);
    context.clearRect(0, 0, rasterWidth, rasterHeight);
    context.fillStyle = PARTICLE_COLOR;
    context.beginPath();
    for (const particle of particles) {
      const x = particle.x ?? particle.targetX;
      const y = particle.y ?? particle.targetY;
      context.moveTo(x + radius, y);
      context.arc(x, y, radius, 0, Math.PI * 2);
    }
    context.fill();
  }

  function shouldRun() {
    return !reducedMotion && !document.hidden && document.hasFocus();
  }

  function syncSimulationActivity() {
    if (!simulation) return;
    if (shouldRun()) {
      simulation.alpha(Math.max(simulation.alpha(), 0.16)).alphaTarget(0.035).restart();
    } else {
      simulation.alphaTarget(0);
      simulation.stop();
    }
  }

  function handlePointerMove(event: PointerEvent) {
    if (reducedMotion || !simulation) return;
    const rect = host.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * rasterWidth;
    const y = (event.clientY - rect.top) / rect.height * rasterHeight;
    for (const particle of particles) {
      const dx = (particle.x ?? particle.targetX) - x;
      const dy = (particle.y ?? particle.targetY) - y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < 58) {
        const strength = (1 - distance / 58) * 1.4;
        particle.vx = (particle.vx ?? 0) + dx / distance * strength;
        particle.vy = (particle.vy ?? 0) + dy / distance * strength;
      }
    }
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
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", syncSimulationActivity);
      window.removeEventListener("blur", syncSimulationActivity);
      document.removeEventListener("visibilitychange", syncSimulationActivity);
    }
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
  {#if !reducedMotion}
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
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

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .reduced {
    height: 100%;
  }
</style>
