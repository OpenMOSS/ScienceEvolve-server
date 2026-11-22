import type { ComponentProps, ReactNode } from "react";

import "./project-interaction.css";

interface ProjectInteractionComposerProps {
  textarea: ComponentProps<"textarea">;
  options?: ReactNode;
  action: ReactNode;
}

export function ProjectInteractionComposer({ textarea, options, action }: ProjectInteractionComposerProps) {
  return (
    <div className="project-interaction-composer">
      <textarea {...textarea} />
      <div className="project-interaction-composer-toolbar">
        {options}
        <div className="project-interaction-composer-action">{action}</div>
      </div>
    </div>
  );
}
