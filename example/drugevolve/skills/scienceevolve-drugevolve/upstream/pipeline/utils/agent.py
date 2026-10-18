import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from config import Config
from agents import ModelSettings, RunConfig, Runner


class AgentLogger:
    """Agent call logger."""
    
    def __init__(self, log_dir: str = Config.AGENT_LOG_DIR):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(exist_ok=True, parents=True)
        self.log_content = os.getenv("DRUGEVOLVE_LOG_CONTENT", "0").lower() in {
            "1",
            "true",
            "yes",
        }
        
        # Main log file
        self.main_log_file = self.log_dir / "agent_calls.log"
        
        # Pipeline related
        self.current_pipeline_id: Optional[str] = None
        self.current_pipeline_dir: Optional[Path] = None
        self.pipeline_log_file: Optional[Path] = None
        self.pipeline_full_log_file: Optional[Path] = None
    
    def start_pipeline(self, pipeline_name: str = "") -> str:
        """Start a new pipeline process."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        self.current_pipeline_id = f"pipeline_{timestamp}_{pipeline_name}" if pipeline_name else f"pipeline_{timestamp}"
        
        # Create pipeline directory and files
        self.current_pipeline_dir = self.log_dir / self.current_pipeline_id
        self.current_pipeline_dir.mkdir(exist_ok=True)
        self.pipeline_log_file = self.current_pipeline_dir / "pipeline.log"
        self.pipeline_full_log_file = self.current_pipeline_dir / "full.log"
        
        # Log pipeline start
        self._write_pipeline_log({
            "pipeline_id": self.current_pipeline_id,
            "timestamp": datetime.now().isoformat(),
            "status": "started",
            "pipeline_name": pipeline_name
        })
        
        self.log_info(f"Started pipeline: {self.current_pipeline_id}")
        return self.current_pipeline_id
    
    def end_pipeline(self, success: bool = True, summary: str = "") -> None:
        """End current pipeline process."""
        if not self.current_pipeline_id:
            print("Warning: No active pipeline to end")
            return
        
        # Get usage statistics
        usage = self._get_pipeline_usage()
        
        # Log pipeline end
        self._write_pipeline_log({
            "pipeline_id": self.current_pipeline_id,
            "timestamp": datetime.now().isoformat(),
            "status": "completed" if success else "failed",
            "summary": summary,
            "usage_summary": usage
        })
        
        # Log usage info
        if usage.get("total_tokens", 0) > 0:
            usage_info = f"Input: {usage['input_tokens']}, Output: {usage['output_tokens']}, Total: {usage['total_tokens']} tokens"
            self.log_info(f"Ended pipeline: {self.current_pipeline_id} ({'success' if success else 'failed'}) - Usage: {usage_info}")
        else:
            self.log_info(f"Ended pipeline: {self.current_pipeline_id} ({'success' if success else 'failed'})")
        
        # Clear pipeline state
        self.current_pipeline_id = None
        self.current_pipeline_dir = None
        self.pipeline_log_file = None
        self.pipeline_full_log_file = None
        
    async def log_agent_call(self, agent_name: str, agent, input_data: Any = None, **kwargs) -> Any:
        """Log and execute agent call."""
        call_id = self._generate_call_id()
        timestamp = datetime.now().isoformat()
        
        # Log call start
        start_log = {
            "call_id": call_id,
            "timestamp": timestamp,
            "agent_name": agent_name,
            "status": "started",
            "input": self._log_payload(input_data),
            "kwargs": self._log_payload(kwargs),
            "pipeline_id": self.current_pipeline_id
        }
        
        self._write_log(start_log)
        if self.current_pipeline_id:
            self._write_pipeline_log(start_log)
        
        try:
            # Execute agent call
            result = await Runner.run(agent, input=input_data, **kwargs)
            
            # Extract usage info
            usage_info = self._extract_usage_from_result(result)
            
            # Log success
            success_log = {
                "call_id": call_id,
                "timestamp": datetime.now().isoformat(),
                "agent_name": agent_name,
                "status": "completed",
                "output": self._log_payload(result),
                "pipeline_id": self.current_pipeline_id,
                "usage": usage_info
            }
            
            self._write_log(success_log)
            if self.current_pipeline_id:
                self._write_pipeline_log(success_log)
            
            # Create detailed log
            self._create_detailed_log(call_id, agent_name, start_log, success_log)
            
            return result
            
        except Exception as e:
            # Log error
            # Extract last traceback frame for precise location
            loc = None
            try:
                tb = e.__traceback__
                while tb and tb.tb_next:
                    tb = tb.tb_next
                if tb:
                    frame = tb.tb_frame
                    filename = frame.f_code.co_filename
                    lineno = tb.tb_lineno
                    func = frame.f_code.co_name
                    loc = f"{os.path.basename(filename)}:{lineno} in {func}"
            except Exception:
                loc = None
            display_error = str(e) if self.log_content else type(e).__name__
            error_log = {
                "call_id": call_id,
                "timestamp": datetime.now().isoformat(),
                "agent_name": agent_name,
                "status": "failed",
                "error": display_error,
                "error_type": type(e).__name__,
                "error_location": loc,
                "pipeline_id": self.current_pipeline_id,
                "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
            }
            
            self._write_log(error_log)
            if self.current_pipeline_id:
                self._write_pipeline_log(error_log)
            # Also print to full log/console with location for quick triage
            if loc:
                self._write_full_log(f"Agent '{agent_name}' error: {display_error} [{loc}]", level="ERROR")
            else:
                self._write_full_log(f"Agent '{agent_name}' error: {display_error}", level="ERROR")
            
            self._create_detailed_log(call_id, agent_name, start_log, error_log)
            raise
    
    def _generate_call_id(self) -> str:
        """Generate unique call ID."""
        return f"call_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
    
    def _extract_usage_from_result(self, result: Any) -> Dict[str, int]:
        """Extract usage information from result."""
        default_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        
        # Check raw_responses
        if hasattr(result, 'raw_responses') and result.raw_responses:
            total_input = total_output = total_tokens = 0
            
            responses = result.raw_responses if isinstance(result.raw_responses, (list, tuple)) else [result.raw_responses]
            
            for response in responses:
                usage = self._extract_usage_from_single_response(response)
                if usage:
                    total_input += usage.get("input_tokens", 0)
                    total_output += usage.get("output_tokens", 0)
                    total_tokens += usage.get("total_tokens", 0)
            
            if total_tokens > 0:
                return {"input_tokens": total_input, "output_tokens": total_output, "total_tokens": total_tokens}
        
        # Check direct usage attribute
        if hasattr(result, 'usage'):
            usage_obj = result.usage
            if hasattr(usage_obj, 'input_tokens'):
                return {
                    "input_tokens": getattr(usage_obj, 'input_tokens', 0),
                    "output_tokens": getattr(usage_obj, 'output_tokens', 0),
                    "total_tokens": getattr(usage_obj, 'total_tokens', 0)
                }
        
        return default_usage
    
    def _extract_usage_from_single_response(self, response: Any) -> Optional[Dict[str, int]]:
        """Extract usage from single API response."""
        if not hasattr(response, 'usage'):
            return None
        
        usage_obj = response.usage
        if not usage_obj:
            return None
        
        # Handle dictionary format
        if isinstance(usage_obj, dict):
            return {
                "input_tokens": usage_obj.get("input_tokens", usage_obj.get("prompt_tokens", 0)),
                "output_tokens": usage_obj.get("output_tokens", usage_obj.get("completion_tokens", 0)),
                "total_tokens": usage_obj.get("total_tokens", 0)
            }
        
        # Handle object format
        if hasattr(usage_obj, 'input_tokens') or hasattr(usage_obj, 'prompt_tokens'):
            input_tokens = getattr(usage_obj, 'input_tokens', 0) or getattr(usage_obj, 'prompt_tokens', 0)
            output_tokens = getattr(usage_obj, 'output_tokens', 0) or getattr(usage_obj, 'completion_tokens', 0)
            total_tokens = getattr(usage_obj, 'total_tokens', input_tokens + output_tokens)
            
            return {"input_tokens": input_tokens, "output_tokens": output_tokens, "total_tokens": total_tokens}
        
        return None
    
    def _get_pipeline_usage(self) -> Dict[str, int]:
        """Get current pipeline usage statistics."""
        if not self.current_pipeline_id or not self.pipeline_log_file or not self.pipeline_log_file.exists():
            return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        
        try:
            usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
            
            with open(self.pipeline_log_file, 'r', encoding='utf-8') as f:
                for line in f:
                    try:
                        log_data = json.loads(line.strip())
                        if log_data.get("status") == "completed" and "usage" in log_data:
                            usage_data = log_data["usage"]
                            usage["input_tokens"] += usage_data.get("input_tokens", 0)
                            usage["output_tokens"] += usage_data.get("output_tokens", 0)
                            usage["total_tokens"] += usage_data.get("total_tokens", 0)
                    except json.JSONDecodeError:
                        continue
            
            return usage
            
        except Exception as e:
            print(f"Failed to get pipeline usage: {e}")
            return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    
    def _serialize_data(self, data: Any, max_depth: int = 10, current_depth: int = 0) -> Any:
        """Serialize data to JSON-serializable format."""
        if current_depth > max_depth:
            return "<max_depth_reached>"
        
        if data is None:
            return None
        elif isinstance(data, (str, int, float, bool)):
            return data
        elif isinstance(data, (list, tuple)):
            return [self._serialize_data(item, max_depth, current_depth + 1) for item in data[:10]]
        elif isinstance(data, dict):
            return {k: self._serialize_data(v, max_depth, current_depth + 1) for k, v in list(data.items())[:20]}
        else:
            return self._serialize_object(data, max_depth, current_depth)

    def _log_payload(self, data: Any) -> Any:
        """Serialize content only when explicitly enabled for trusted runs."""
        if self.log_content:
            return self._serialize_data(data)
        if data is None:
            return None
        return {"redacted": True, "type": type(data).__name__}
    
    def _serialize_object(self, data: Any, max_depth: int, current_depth: int) -> Any:
        """Serialize complex objects."""
        try:
            # Pydantic models
            if hasattr(data, 'model_dump'):
                try:
                    return {
                        "_type": "PydanticModel",
                        "_class": type(data).__name__,
                        "data": self._serialize_data(data.model_dump(), max_depth, current_depth + 1)
                    }
                except Exception:
                    pass
            
            if hasattr(data, 'dict') and hasattr(data, '__fields__'):
                try:
                    return {
                        "_type": "PydanticModel",
                        "_class": type(data).__name__,
                        "data": self._serialize_data(data.dict(), max_depth, current_depth + 1)
                    }
                except Exception:
                    pass
            
            # Objects with to_dict method
            if hasattr(data, 'to_dict') and callable(getattr(data, 'to_dict')):
                try:
                    return {
                        "_type": "ObjectWithToDict",
                        "_class": type(data).__name__,
                        "data": self._serialize_data(data.to_dict(), max_depth, current_depth + 1)
                    }
                except Exception:
                    pass
            
            # Dataclasses
            if hasattr(data, '__dataclass_fields__'):
                try:
                    from dataclasses import asdict
                    return {
                        "_type": "Dataclass",
                        "_class": type(data).__name__,
                        "data": self._serialize_data(asdict(data), max_depth, current_depth + 1)
                    }
                except Exception:
                    pass
            
            # Regular objects
            if hasattr(data, '__dict__'):
                try:
                    return {
                        "_type": "Object",
                        "_class": type(data).__name__,
                        "data": {k: self._serialize_data(v, max_depth, current_depth + 1) 
                               for k, v in data.__dict__.items() if not k.startswith('_')}
                    }
                except Exception:
                    pass
            
            # Try JSON serialization
            try:
                json.dumps(data)
                return data
            except (TypeError, ValueError):
                pass
            
            # Convert to string
            try:
                str_repr = str(data)
                return {
                    "_type": "String",
                    "_class": type(data).__name__,
                    "data": str_repr[:1000] + ("..." if len(str_repr) > 1000 else "")
                }
            except Exception:
                return {
                    "_type": "UnserializableObject",
                    "_class": type(data).__name__,
                    "error": "Cannot serialize this object"
                }
                
        except Exception as e:
            return {
                "_type": "SerializationError",
                "_class": type(data).__name__ if hasattr(data, '__class__') else 'unknown',
                "error": str(e)
            }
    
    def _write_log(self, log_data: Dict[str, Any]) -> None:
        """Write log to main log file."""
        try:
            with open(self.main_log_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(log_data, ensure_ascii=False) + '\n')
        except Exception as e:
            print(f"Failed to write log: {e}")
    
    def _create_detailed_log(self, call_id: str, agent_name: str, start_log: Dict, end_log: Dict) -> None:
        """Create detailed single call log file."""
        try:
            detailed_log = {
                "call_summary": {
                    "call_id": call_id,
                    "agent_name": agent_name,
                    "start_time": start_log["timestamp"],
                    "end_time": end_log["timestamp"],
                    "status": end_log["status"],
                    "pipeline_id": self.current_pipeline_id
                },
                "start_log": start_log,
                "end_log": end_log
            }
            
            filename = f"{call_id}_{agent_name}.json"
            
            if self.current_pipeline_id and self.current_pipeline_dir:
                detailed_file = self.current_pipeline_dir / filename
            else:
                detailed_file = self.log_dir / "detailed" / filename
                detailed_file.parent.mkdir(exist_ok=True)
            
            with open(detailed_file, 'w', encoding='utf-8') as f:
                json.dump(detailed_log, f, ensure_ascii=False, indent=2)
                
        except Exception as e:
            print(f"Failed to create detailed log: {e}")
    
    def _write_pipeline_log(self, log_data: Dict[str, Any]) -> None:
        """Write log to pipeline log file."""
        try:
            if self.pipeline_log_file:
                with open(self.pipeline_log_file, 'a', encoding='utf-8') as f:
                    f.write(json.dumps(log_data, ensure_ascii=False) + '\n')
        except Exception as e:
            print(f"Failed to write pipeline log: {e}")
    
    def _write_full_log(self, message: str, level: str = "INFO") -> None:
        """Write to full log file and console."""
        try:
            if self.pipeline_full_log_file:
                timestamp = datetime.now().isoformat()
                log_entry = f"[{timestamp}] [{level}] {message}\n"
                with open(self.pipeline_full_log_file, 'a', encoding='utf-8') as f:
                    f.write(log_entry)
            print(f"[{level}] {message}")
        except Exception as e:
            print(f"Failed to write full log: {e}")
    
    def log_info(self, message: str) -> None:
        """Log info message."""
        self._write_full_log(message, "INFO")
    
    def log_warning(self, message: str) -> None:
        """Log warning message."""
        self._write_full_log(message, "WARNING")
    
    def log_error(self, message: str) -> None:
        """Log error message."""
        self._write_full_log(message, "ERROR")
    
    def log_debug(self, message: str) -> None:
        """Log debug message."""
        self._write_full_log(message, "DEBUG")
    
    def log_step(self, step_name: str, message: str = "") -> None:
        """Log step message."""
        full_message = f"=== {step_name} ===" + (f" {message}" if message else "")
        self._write_full_log(full_message, "STEP")
    
    def get_agent_call_stats(self) -> Dict[str, Any]:
        """Get agent call statistics."""
        try:
            if not self.main_log_file.exists():
                return {
                    "total_calls": 0, 
                    "by_agent": {}, 
                    "by_status": {},
                    "usage": {"total_input_tokens": 0, "total_output_tokens": 0, "total_tokens": 0, "by_agent": {}}
                }
            
            stats = {
                "total_calls": 0,
                "by_agent": {},
                "by_status": {"started": 0, "completed": 0, "failed": 0},
                "usage": {"total_input_tokens": 0, "total_output_tokens": 0, "total_tokens": 0, "by_agent": {}}
            }
            
            # Merge logs by call_id
            agent_calls = {}
            with open(self.main_log_file, 'r', encoding='utf-8') as f:
                for line in f:
                    try:
                        log_data = json.loads(line.strip())
                        call_id = log_data.get("call_id")
                        if call_id:
                            if call_id not in agent_calls:
                                agent_calls[call_id] = {}
                            agent_calls[call_id].update(log_data)
                    except json.JSONDecodeError:
                        continue
            
            # Aggregate statistics
            for call_id, log_data in agent_calls.items():
                stats["total_calls"] += 1
                agent_name = log_data.get("agent_name", "unknown")
                status = log_data.get("status", "unknown")
                
                stats["by_agent"][agent_name] = stats["by_agent"].get(agent_name, 0) + 1
                if status in stats["by_status"]:
                    stats["by_status"][status] += 1
                
                # Usage statistics
                if status == "completed":
                    usage_data = log_data.get("usage", {})
                    if usage_data:
                        input_tokens = usage_data.get("input_tokens", 0)
                        output_tokens = usage_data.get("output_tokens", 0)
                        total_tokens = usage_data.get("total_tokens", 0)
                        
                        stats["usage"]["total_input_tokens"] += input_tokens
                        stats["usage"]["total_output_tokens"] += output_tokens
                        stats["usage"]["total_tokens"] += total_tokens
                        
                        if agent_name not in stats["usage"]["by_agent"]:
                            stats["usage"]["by_agent"][agent_name] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
                        
                        stats["usage"]["by_agent"][agent_name]["input_tokens"] += input_tokens
                        stats["usage"]["by_agent"][agent_name]["output_tokens"] += output_tokens
                        stats["usage"]["by_agent"][agent_name]["total_tokens"] += total_tokens

            return stats
            
        except Exception as e:
            print(f"Failed to get stats: {e}")
            return {"error": str(e)}


# Global logger instance
_global_logger = None

def get_logger() -> AgentLogger:
    """Get global logger instance."""
    global _global_logger
    if _global_logger is None:
        _global_logger = AgentLogger()
    return _global_logger

async def run(agent_name: str, agent, input_data: Any = None, **kwargs) -> Any:
    """Log and execute agent call."""
    reasoning_effort = os.getenv("DRUGEVOLVE_REASONING_EFFORT", "").strip()
    if reasoning_effort and "run_config" not in kwargs:
        kwargs["run_config"] = RunConfig(
            model_settings=ModelSettings(reasoning={"effort": reasoning_effort})
        )
    logger = get_logger()
    result = await logger.log_agent_call(agent_name, agent, input_data, **kwargs)
    return result.final_output

def start_pipeline(pipeline_name: str = "") -> str:
    """Start a new pipeline process."""
    logger = get_logger()
    return logger.start_pipeline(pipeline_name)

def end_pipeline(success: bool = True, summary: str = "") -> None:
    """End current pipeline process."""
    logger = get_logger()
    logger.end_pipeline(success, summary)

def get_current_pipeline_id() -> Optional[str]:
    """Get current pipeline ID."""
    logger = get_logger()
    return logger.current_pipeline_id

def log_info(message: str) -> None:
    """Log info message."""
    logger = get_logger()
    logger.log_info(message)

def log_warning(message: str) -> None:
    """Log warning message."""
    logger = get_logger()
    logger.log_warning(message)

def log_error(message: str) -> None:
    """Log error message."""
    logger = get_logger()
    logger.log_error(message)

def log_debug(message: str) -> None:
    """Log debug message."""
    logger = get_logger()
    logger.log_debug(message)

def log_step(step_name: str, message: str = "") -> None:
    """Log step message."""
    logger = get_logger()
    logger.log_step(step_name, message)

def get_usage_stats() -> Dict[str, Any]:
    """Get usage statistics."""
    logger = get_logger()
    stats = logger.get_agent_call_stats()
    return stats.get("usage", {})

def get_current_pipeline_usage() -> Dict[str, int]:
    """Get current pipeline usage."""
    logger = get_logger()
    return logger._get_pipeline_usage()

def log_usage_summary() -> None:
    """Print current usage summary."""
    logger = get_logger()
    stats = get_usage_stats()
    
    if stats and stats.get("total_tokens", 0) > 0:
        total_info = f"Total session usage: Input: {stats['total_input_tokens']}, Output: {stats['total_output_tokens']}, Total: {stats['total_tokens']} tokens"
        logger.log_info(total_info)
        
        if logger.current_pipeline_id:
            pipeline_usage = get_current_pipeline_usage()
            if pipeline_usage.get("total_tokens", 0) > 0:
                pipeline_info = f"Current pipeline usage: Input: {pipeline_usage['input_tokens']}, Output: {pipeline_usage['output_tokens']}, Total: {pipeline_usage['total_tokens']} tokens"
                logger.log_info(pipeline_info)
    else:
        logger.log_info("No usage data available yet.")
