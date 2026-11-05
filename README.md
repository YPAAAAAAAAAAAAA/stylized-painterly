# Painterly

Full-bleed auto-play of one effect from [cortiz2894/stylized-components](https://github.com/cortiz2894/stylized-components): an anisotropic Kuwahara oil-paint filter, with depth ink and a watercolor grade, on the starter scene (a lit torus knot and a shadow-only ground).

The scene starts on its own. One finger orbits the camera. A pinch zooms, and the knot and its shadow stay inside the frame.

## Credit

Adapted from the `/painterly` route and `src/components/kuwahara/` plus the painterly starter, outline, and watercolor passes.

**Upstream:** [cortiz2894/stylized-components](https://github.com/cortiz2894/stylized-components)  
**Author:** Christian Ortiz (Cortiz)  
**License:** MIT. The copyright notice and permission text are in `LICENSE`.

## iPhone

WebGL2 only. There is no WebGPU path. Device pixel ratio is pinned to 1 so the brush stays the size the filter was tuned for. If WebGL2 or a float color buffer is missing, the canvas stays black.
