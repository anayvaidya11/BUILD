import type { Metadata } from "next";
import Landing from "@/components/landing/Landing";
import "./welcome.css";

export const metadata: Metadata = {
  title: "BUILD — Imagine your home. Then walk through it.",
  description: "Turn a home idea into a rule-checked floor plan and explore it in 3D. Describe, generate, explore and refine with BUILD.",
};

export default function Welcome() { return <Landing />; }
