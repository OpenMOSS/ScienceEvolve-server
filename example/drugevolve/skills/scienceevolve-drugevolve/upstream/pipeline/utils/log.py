#!/usr/bin/env python3
"""
Agent call log viewer

Usage:
    python log.py --stats                        # Show statistics
    python log.py --list                         # List all calls
    python log.py --agent planner                # View specific agent calls
    python log.py --failed                       # View failed calls
    python log.py --detail <call_id>             # View specific call details
    python log.py --recent 10                    # View recent 10 calls
    python log.py --pipelines                    # List all pipelines
    python log.py --pipeline <pipeline_id>       # View pipeline details
    python log.py --agent-pipeline <agent>       # View agent calls across pipelines
"""

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .agent import AgentLogger


class LogViewer:
    def __init__(self, log_dir: str = "logs/agent_calls"):
        self.log_dir = Path(log_dir)
        self.main_log_file = self.log_dir / "agent_calls.log"
        self.detailed_dir = self.log_dir / "detailed"
    
    def get_all_logs(self) -> List[Dict[str, Any]]:
        """Get all log entries."""
        if not self.main_log_file.exists():
            return []
        
        logs = []
        with open(self.main_log_file, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    log_data = json.loads(line.strip())
                    logs.append(log_data)
                except json.JSONDecodeError:
                    continue
        return logs
    
    def show_stats(self):
        """Show statistics."""
        logger = AgentLogger(str(self.log_dir))
        stats = logger.get_agent_call_stats()
        
        print("=== Agent Call Statistics ===")
        print(f"Total calls: {stats.get('total_calls', 0)}")
        
        print("\nBy Agent:")
        for agent, count in stats.get('by_agent', {}).items():
            print(f"  {agent}: {count} times")
        
        print("\nBy Status:")
        for status, count in stats.get('by_status', {}).items():
            print(f"  {status}: {count} times")
        
        # Show usage statistics
        usage = stats.get('usage', {})
        if usage.get('total_tokens', 0) > 0:
            print(f"\nUsage Statistics:")
            print(f"  Total tokens: {usage['total_tokens']}")
            print(f"  Input tokens: {usage['total_input_tokens']}")
            print(f"  Output tokens: {usage['total_output_tokens']}")
    
    def list_calls(self, agent_filter: Optional[str] = None, status_filter: Optional[str] = None, limit: Optional[int] = None):
        """List call records."""
        logs = self.get_all_logs()
        
        # Filter
        if agent_filter:
            logs = [log for log in logs if log.get('agent_name') == agent_filter]
        if status_filter:
            logs = [log for log in logs if log.get('status') == status_filter]
        
        # Sort by time
        logs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        
        # Limit count
        if limit:
            logs = logs[:limit]
        
        print("=== Agent Call Records ===")
        for log in logs:
            timestamp = log.get('timestamp', 'N/A')
            call_id = log.get('call_id', 'N/A')
            agent_name = log.get('agent_name', 'N/A')
            status = log.get('status', 'N/A')
            
            # Format timestamp
            try:
                dt = datetime.fromisoformat(timestamp)
                formatted_time = dt.strftime('%Y-%m-%d %H:%M:%S')
            except:
                formatted_time = timestamp
            
            status_symbol = "✓" if status == "completed" else "✗" if status == "failed" else "→"
            print(f"{status_symbol} {formatted_time} | {agent_name:15} | {status:10} | {call_id}")
    
    def show_detail(self, call_id: str):
        """Show call details."""
        detailed_files = list(self.detailed_dir.glob(f"{call_id}_*.json"))
        
        if not detailed_files:
            print(f"Detailed information for call ID {call_id} not found")
            return
        
        detailed_file = detailed_files[0]
        
        try:
            with open(detailed_file, 'r', encoding='utf-8') as f:
                detail = json.load(f)
            
            print(f"=== Call Details: {call_id} ===")
            
            # Basic information
            summary = detail.get('call_summary', {})
            print(f"Agent: {summary.get('agent_name', 'N/A')}")
            print(f"Status: {summary.get('status', 'N/A')}")
            print(f"Start time: {summary.get('start_time', 'N/A')}")
            print(f"End time: {summary.get('end_time', 'N/A')}")
            
            # Input information
            start_log = detail.get('start_log', {})
            print(f"\n--- Input ---")
            input_data = start_log.get('input')
            if input_data:
                print(json.dumps(input_data, ensure_ascii=False, indent=2)[:1000] + "..." if len(str(input_data)) > 1000 else json.dumps(input_data, ensure_ascii=False, indent=2))
            
            # Output information
            end_log = detail.get('end_log', {})
            print(f"\n--- Output ---")
            if end_log.get('status') == 'completed':
                output_data = end_log.get('output')
                if output_data:
                    print(json.dumps(output_data, ensure_ascii=False, indent=2)[:1000] + "..." if len(str(output_data)) > 1000 else json.dumps(output_data, ensure_ascii=False, indent=2))
            else:
                print(f"Error: {end_log.get('error', 'N/A')}")
                print(f"Error type: {end_log.get('error_type', 'N/A')}")
            
        except Exception as e:
            print(f"Failed to read details: {e}")
    
    def show_recent_failures(self, limit: int = 10):
        """Show recent failed calls."""
        print("=== Recent Failed Calls ===")
        self.list_calls(status_filter="failed", limit=limit)
        
        # Show error details
        logs = self.get_all_logs()
        failed_logs = [log for log in logs if log.get('status') == 'failed']
        failed_logs.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
        
        for i, log in enumerate(failed_logs[:5]):
            print(f"\n--- Error Details {i+1} ---")
            print(f"Agent: {log.get('agent_name', 'N/A')}")
            print(f"Time: {log.get('timestamp', 'N/A')}")
            print(f"Error: {log.get('error', 'N/A')}")
    
    def list_pipelines(self, limit: Optional[int] = None):
        """List all pipelines."""
        pipeline_dirs = [d for d in self.log_dir.iterdir() if d.is_dir() and d.name.startswith('pipeline_')]
        pipeline_dirs.sort(key=lambda x: x.name, reverse=True)
        
        if limit:
            pipeline_dirs = pipeline_dirs[:limit]
        
        print("=== Pipeline List ===")
        for pipeline_dir in pipeline_dirs:
            pipeline_log = pipeline_dir / "pipeline.log"
            if pipeline_log.exists():
                start_info = None
                end_info = None
                agent_count = 0
                
                with open(pipeline_log, 'r', encoding='utf-8') as f:
                    for line in f:
                        try:
                            log_data = json.loads(line.strip())
                            if log_data.get('status') == 'started' and not start_info:
                                start_info = log_data
                            elif log_data.get('status') in ['completed', 'failed']:
                                end_info = log_data
                            elif 'agent_name' in log_data:
                                agent_count += 1
                        except json.JSONDecodeError:
                            continue
                
                # Format display
                pipeline_name = start_info.get('pipeline_name', '') if start_info else ''
                start_time = start_info.get('timestamp', 'N/A') if start_info else 'N/A'
                status = end_info.get('status', 'running') if end_info else 'running'
                summary = end_info.get('summary', '') if end_info else ''
                
                try:
                    dt = datetime.fromisoformat(start_time)
                    formatted_time = dt.strftime('%Y-%m-%d %H:%M:%S')
                except:
                    formatted_time = start_time
                
                status_symbol = "✓" if status == "completed" else "✗" if status == "failed" else "→"
                print(f"{status_symbol} {formatted_time} | {pipeline_dir.name} | {status} | {agent_count} agents | {summary}")
    
    def show_pipeline_detail(self, pipeline_id: str):
        """Show pipeline details."""
        pipeline_dir = self.log_dir / pipeline_id
        
        if not pipeline_dir.exists():
            print(f"Pipeline not found: {pipeline_id}")
            return
        
        pipeline_log = pipeline_dir / "pipeline.log"
        if not pipeline_log.exists():
            print(f"Pipeline log file does not exist: {pipeline_id}")
            return
        
        print(f"=== Pipeline Details: {pipeline_id} ===")
        
        # Read pipeline logs
        pipeline_logs = []
        with open(pipeline_log, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    log_data = json.loads(line.strip())
                    pipeline_logs.append(log_data)
                except json.JSONDecodeError:
                    continue
        
        # Analyze logs
        start_log = None
        end_log = None
        agent_calls = []
        
        for log in pipeline_logs:
            if log.get('status') == 'started' and 'agent_name' not in log:
                start_log = log
            elif log.get('status') in ['completed', 'failed'] and 'agent_name' not in log:
                end_log = log
            elif 'agent_name' in log:
                agent_calls.append(log)
        
        # Show basic information
        if start_log:
            print(f"Start time: {start_log.get('timestamp', 'N/A')}")
            print(f"Pipeline name: {start_log.get('pipeline_name', 'Unnamed')}")
        
        if end_log:
            print(f"End time: {end_log.get('timestamp', 'N/A')}")
            print(f"Status: {end_log.get('status', 'N/A')}")
            print(f"Summary: {end_log.get('summary', 'N/A')}")
            
            # Show usage summary
            usage_summary = end_log.get('usage_summary', {})
            if usage_summary.get('total_tokens', 0) > 0:
                print(f"Usage: Input {usage_summary['input_tokens']}, Output {usage_summary['output_tokens']}, Total {usage_summary['total_tokens']} tokens")
        else:
            print("Status: running")
        
        # Show agent call sequence
        if agent_calls:
            print(f"\n--- Agent Call Sequence ({len(agent_calls)} calls) ---")
            for i, call in enumerate(agent_calls, 1):
                timestamp = call.get('timestamp', 'N/A')
                agent_name = call.get('agent_name', 'N/A')
                status = call.get('status', 'N/A')
                
                try:
                    dt = datetime.fromisoformat(timestamp)
                    formatted_time = dt.strftime('%H:%M:%S')
                except:
                    formatted_time = timestamp
                
                status_symbol = "✓" if status == "completed" else "✗" if status == "failed" else "→"
                print(f"  {i:2d}. {status_symbol} {formatted_time} | {agent_name:15} | {status}")
        
        # Show detail files
        detail_files = list(pipeline_dir.glob("call_*.json"))
        if detail_files:
            print(f"\nDetailed log files: {len(detail_files)} files")
            for file in sorted(detail_files):
                print(f"  - {file.name}")

    def show_pipeline_by_agent(self, agent_name: str, limit: Optional[int] = None):
        """Show specific agent calls across pipelines."""
        print(f"=== Agent '{agent_name}' Pipeline Call Records ===")
        
        pipeline_dirs = [d for d in self.log_dir.iterdir() if d.is_dir() and d.name.startswith('pipeline_')]
        pipeline_dirs.sort(key=lambda x: x.name, reverse=True)
        
        if limit:
            pipeline_dirs = pipeline_dirs[:limit]
        
        found_calls = []
        
        for pipeline_dir in pipeline_dirs:
            pipeline_log = pipeline_dir / "pipeline.log"
            if pipeline_log.exists():
                with open(pipeline_log, 'r', encoding='utf-8') as f:
                    for line in f:
                        try:
                            log_data = json.loads(line.strip())
                            if log_data.get('agent_name') == agent_name:
                                log_data['pipeline_id'] = pipeline_dir.name
                                found_calls.append(log_data)
                        except json.JSONDecodeError:
                            continue
        
        if not found_calls:
            print(f"No call records found for agent '{agent_name}'")
            return
        
        for call in found_calls:
            timestamp = call.get('timestamp', 'N/A')
            status = call.get('status', 'N/A')
            pipeline_id = call.get('pipeline_id', 'N/A')
            
            try:
                dt = datetime.fromisoformat(timestamp)
                formatted_time = dt.strftime('%Y-%m-%d %H:%M:%S')
            except:
                formatted_time = timestamp
            
            status_symbol = "✓" if status == "completed" else "✗" if status == "failed" else "→"
            print(f"{status_symbol} {formatted_time} | {pipeline_id} | {status}")
            
            if call.get('error'):
                print(f"    Error: {call.get('error')}")
            elif call.get('output'):
                output_summary = str(call.get('output'))[:100] + "..." if len(str(call.get('output'))) > 100 else str(call.get('output'))
                print(f"    Output: {output_summary}")


def main():
    parser = argparse.ArgumentParser(description='Agent call log viewer')
    parser.add_argument('--stats', action='store_true', help='Show statistics')
    parser.add_argument('--list', action='store_true', help='List all calls')
    parser.add_argument('--agent', type=str, help='Filter specific agent')
    parser.add_argument('--failed', action='store_true', help='Show failed calls')
    parser.add_argument('--detail', type=str, help='Show specific call details')
    parser.add_argument('--recent', type=int, help='Show recent N calls')
    parser.add_argument('--log-dir', type=str, default='logs/agent_calls', help='Log directory path')
    parser.add_argument('--pipelines', action='store_true', help='List all pipelines')
    parser.add_argument('--pipeline', type=str, help='Show specific pipeline details')
    parser.add_argument('--agent-pipeline', type=str, help='Show specific agent call records across pipelines')
    
    args = parser.parse_args()
    
    viewer = LogViewer(args.log_dir)
    
    if args.pipelines:
        viewer.list_pipelines(args.recent)
    elif args.pipeline:
        viewer.show_pipeline_detail(args.pipeline)
    elif args.agent_pipeline:
        viewer.show_pipeline_by_agent(args.agent_pipeline, args.recent)
    elif args.stats:
        viewer.show_stats()
    elif args.detail:
        viewer.show_detail(args.detail)
    elif args.failed:
        viewer.show_recent_failures()
    elif args.list or args.agent or args.recent:
        viewer.list_calls(
            agent_filter=args.agent,
            limit=args.recent
        )
    else:
        # Default show pipelines and statistics
        print("=== Recent Pipelines ===")
        viewer.list_pipelines(5)
        print("\n=== Statistics ===")
        viewer.show_stats()


if __name__ == "__main__":
    main()