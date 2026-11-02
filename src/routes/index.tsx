import { createFileRoute } from "@tanstack/react-router";
import { JudgeDesk } from "@/components/desk/judge-desk";

export const Route = createFileRoute("/")({ component: JudgeDesk });
