import { CollaborationStateDatabase } from "../server/dist/src/collaboration-state/store.js";
import { EventLogIndex } from "../server/dist/src/event-log-index.js";
import { ProjectStorage, deferTraceDetail } from "../server/dist/src/storage.js";
import { isWorkflowReplayEvent } from "../server/dist/src/workflow-replay.js";

export function installCompatWorkflowReplay({ orchestrator, storage }) {
  if (typeof storage.readEventDetails !== "function") {
    const bootstrap = storage.readEventBootstrap.bind(storage);
    const history = storage.readEventHistory.bind(storage);
    const reader = {
      stableEventSnapshotSize: storage.stableEventSnapshotSize.bind(storage),
      projectDir: storage.projectDir.bind(storage),
      eventLogs: new EventLogIndex(() => false)
    };
    storage.readEventBootstrap = async (projectId, limit, compactTrace) => {
      const page = await bootstrap(projectId, limit);
      return compactTrace ? { ...page, events: page.events.map((event, index, events) =>
        index < events.length - 40 ? deferTraceDetail(event) : event) } : page;
    };
    storage.readEventHistory = async (projectId, before, limit, compactTrace) => {
      const page = await history(projectId, before, limit);
      return compactTrace ? { ...page, events: page.events.map(deferTraceDetail) } : page;
    };
    storage.readEventDetails = ProjectStorage.prototype.readEventDetails.bind(reader);
    storage.readMessageHistory = ProjectStorage.prototype.readMessageHistory.bind(reader);
  }

  if (typeof storage.readWorkflowReplayHistory !== "function") {
    const reader = {
      stableEventSnapshotSize: storage.stableEventSnapshotSize.bind(storage),
      projectDir: storage.projectDir.bind(storage),
      workflowReplayLogs: new EventLogIndex(isWorkflowReplayEvent)
    };
    storage.readWorkflowReplayHistory = ProjectStorage.prototype.readWorkflowReplayHistory.bind(reader);
  }

  if (typeof orchestrator.getWorkflowReplayConfigurationHistory !== "function") {
    const readConfiguration = CollaborationStateDatabase.prototype.workflowReplayConfigurationHistory;
    orchestrator.getWorkflowReplayConfigurationHistory = async projectId => {
      const project = await orchestrator.getProject(projectId);
      const database = orchestrator.collaborationRuntime.database();
      return readConfiguration.call(database, project?.id ?? projectId);
    };
  }
}
