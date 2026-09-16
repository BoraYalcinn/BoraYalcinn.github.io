---
title: CezveRender
date: 2026-05-07
draft: false
repo: CezveRender
description: A real-time 3D renderer written from scratch in Java, on OpenGL 3.3
  and LWJGL — my first large project.
tags:
  - java
  - opengl
  - lwjgl
  - graphics
  - renderer
---
CezveRender is a real-time 3D renderer I wrote from scratch in Java, on top of
OpenGL 3.3 through LWJGL. It was my first large-scale personal project, and the
point of it was to learn graphics programming from the ground up rather than to
ship something polished — shadow mapping, lighting models, scene management and
the GPU side of rendering, all built by hand instead of taken off a shelf.

## Why Java

Java is an unusual choice for a renderer, and it was a deliberate one: at the
time it was the language I knew best. I wanted the difficulty of the project to
come from the graphics — from understanding why a shadow map acnes, or what a
cubemap face has to do with a point light — not from fighting a language I was
still learning. LWJGL gives you the real OpenGL API with almost no abstraction
over it, so nothing about the graphics work was made easier or hidden; only the
surrounding code was in familiar territory.

## What it does

**Lighting.** Directional lights with orthographic shadow mapping, point lights
with cubemap shadow mapping rendered in a single pass via a geometry shader, and
spot lights with perspective shadow mapping. Shading is Phong — ambient, diffuse
and specular, per material.

**Shadows.** Soft shadows for directional and spot lights, with the shadow bias
adjustable at runtime so you can watch acne and peter-panning trade off against
each other directly.

**Scenes.** OBJ model loading through Assimp, with MTL and textures. Cubemap
skybox. Procedural meshes for floors, cubes and pyramids. Full transform
handling — position, rotation, scale.

**An editor.** An ImGui panel that runs with the renderer: add, remove and
transform models live, create and edit every light type, build a floor with a
custom texture, and switch on the debug tools — shadow map overlay, the light's
own camera view, shadow debug visualisation, and the bias slider.

## Watch it run

The full showcase is on YouTube:
[CezveRender project showcase](https://youtube.com/watch?v=AYtOxsVArtw).

## Built with

LWJGL 3 for the OpenGL, GLFW and OpenAL bindings; Assimp for model loading;
JOML for vector and matrix maths; imgui-java for the editor; STB for image
loading; Maven for the build, wrapped so no local Maven install is needed.

## Running it

Java 17 or newer is the only prerequisite — the repo ships the Maven Wrapper, so
Maven downloads itself on first run.

```bash
git clone https://github.com/BoraYalcinn/CezveRender.git
cd CezveRender
./mvnw compile exec:java        # mvnw.cmd on Windows
```

`Tab` switches between editor and camera mode, `WASD` and the mouse fly the
camera, `F` toggles fullscreen.

## Known rough edges

 There is no scene save or load. Shadow coverage is bounded by the size of the directional  
light's orthographic frustum.



Issues and pull requests are welcome — the repo is meant to be picked apart.