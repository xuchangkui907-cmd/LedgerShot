import { createFileRoute } from "@tanstack/react-router";
import { OpsConsole } from "@/components/ops/console";

export const Route = createFileRoute("/ops")({ component: OpsConsole });
