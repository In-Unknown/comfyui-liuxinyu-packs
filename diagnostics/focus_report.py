"""Decode saved ETL locally; keep source fields distinct from event context PID."""
import argparse
from collections import Counter, deque
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

NS = {'e': 'http://schemas.microsoft.com/win/2004/08/events/event'}


def summarize(xml_path, target_pid=0, target_hwnd=0):
    counts = Counter()
    selected = deque(maxlen=1000)
    messages = deque(maxlen=100)
    stack_count = 0
    for _, element in ET.iterparse(xml_path, events=('end',)):
        if element.tag != '{' + NS['e'] + '}Event':
            continue
        system = element.find('e:System', NS)
        provider = system.find('e:Provider', NS)
        if provider is not None and provider.get('Name') == 'Microsoft-Windows-Win32k':
            event_id = int(system.findtext('e:EventID', namespaces=NS))
            counts[event_id] += 1
            data = {item.get('Name'): (item.text or '').strip()
                    for item in element.findall('e:EventData/e:Data', NS)}
            frames = [item.text for item in system.findall('e:Stack/e:Address', NS)]
            stack_count += bool(frames)
            destination = int(data.get('DestinationHwnd', '0'), 0)
            source = int(data.get('SourceProcessId', '0'))
            if event_id != 426 or (target_hwnd and destination == target_hwnd) or (target_pid and source == target_pid):
                execution = system.find('e:Execution', NS)
                (messages if event_id == 426 else selected).append({'id': event_id, 'time': system.find('e:TimeCreated', NS).get('SystemTime'),
                                 'contextPid': execution.get('ProcessID'), 'contextTid': execution.get('ThreadID'),
                                 'data': data, 'stack': frames})
        element.clear()
    return {'eventCounts': dict(counts), 'eventsWithStacks': stack_count, 'targetPid': target_pid,
            'targetHwnd': target_hwnd, 'events': sorted([*selected, *messages], key=lambda event: event['time']),
            'interpretation': 'contextPid is execution context, not automatically the initiator. '
                              'Event 426 SourceProcessId/SourceThreadId describe the null-message sender. '
                              'Use original ETL image/process rundown to resolve stack addresses; '
                              'a null message alone does not prove it requested restore or flash.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('etl', type=Path)
    parser.add_argument('--pid', type=int, default=0)
    parser.add_argument('--hwnd', type=int, default=0)
    args = parser.parse_args()
    xml = args.etl.with_suffix('.decoding.xml')
    result = subprocess.run(['tracerpt', str(args.etl), '-o', str(xml), '-of', 'XML', '-y'],
                            capture_output=True, timeout=60, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError(result.stdout.decode(errors='replace') + result.stderr.decode(errors='replace'))
    report = summarize(xml, args.pid, args.hwnd)
    args.etl.with_suffix('.summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    xml.unlink()
    print(json.dumps({'eventCounts': report['eventCounts'], 'eventsWithStacks': report['eventsWithStacks']}))
