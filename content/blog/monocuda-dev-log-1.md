---
title: "MonoCUDA -  Dev Log #1"
date: 2026-09-17
draft: true
categories:
  - Dev
tags:
  - CUDA
  - ComputerGraphics
cover: /images/renderv2.jpg
featured: true
---
Hi everyone this is my first blog post and dev log number 1 for my new project MonoCUDA where I am building a path tracer using CUDA in a single file !

In this post I will go over what I've learned about CUDA, what I've covered so far and some math essentials for a project like this :D all the drawing I've used in this  post is drawn by me . I tried my best to visualize how I think about math and make these calculations. So lets get started !

This project idea came to my mind when I started reading peter shirley's books about ray tracing in a weekend and when I finished the first book and tried to render the final scene it used %100 percent of my cpu and took incredibly long to render. I guess thats why we have GPU's nowadays right ? but seriously path tracing is one of those areas of computer graphics where multithreading , using the GPU and parallel computing matters !

so first thing I've done when I started is to fetch my device and gpu capabilities this is important because NVIDIA has all kinds of different architectures and different types of GPU's for example mine is a rtx 5070 gpu made for laptops and yours might be different meaning that it has different numbers SM's and number of threads it can run but in this project I've used 16,16 which usually works just fine for many gpu's but in the upcoming days I will update this to a not hardcoded version :=)

in CUDA parallelism can be achieved by using kernels and threads with keywordslike **host** and **device** which if we use both on a function it means that it will run both on CPU and GPU oh ! and also in CUDA error handling has 2 layers KERNEL layer and API call layer which was also one of the first things I've done you can see the code below. but okey back to what I was saying so kernel calls are actually what runs on gpu with many block and threads running in parallel executed randomly ! so as everybody can guess the smart move to be done would be making the render function a kernel so that we can done the heavy work by gpu !

what I've first done was to get a gradient from top left to right bottom thats the way I usually like going for because it just feels right for me. but first instead of sending rays each center pixel ı've first used rasteriazation and printed a white triangle on the screen to get a grip.

// image

things get complicated when we want to switch to ray tracing because path tracing is nothing like rasterizers. we send rays for each pixel and we calculate bounces and etc. which make a ton load of calculations. But first I've started with essentials and that would be spheres and triangles (triangles are great for future extension to load objetcs since in most caes everytthing derives from a triangle !) so lets assume we are sending a ray to a sphere. What do we need to know ? if you said if it hits that sphere you've said it right lets take a look at the image and code below

// image and my code

and what if it was a triangle ?..explanation 

// image and my code



okey so now we know how to calculate all this stuff but we do need a camera right ? I haven't told you but when we are sending rays we are actually sending them thourgh a imaginery window called viewport and theres another ton of math coming up so be ready.

// image and my code...and explanation

okey so we've get that out of checklist too.wuhh so now after 