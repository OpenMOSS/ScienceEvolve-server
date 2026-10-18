"""Local protocol/IO tests. Fixture replies are not scientific model runs."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from test_method_protocols import module


class HypothesisPool(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = module('co-scientist', 'pool.py')

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.plan = dict(goal='fixture', criteria=['testability'], constraints=[], stop_condition='test budget')
        self.m.initialize(self.root, self.plan)

    def candidate(self, identifier, **extra):
        return dict(id=identifier, summary='fixture', category='test', mechanism='fixture', assumptions=[], evidence=[], test_plan='fixture', source='generation', **extra)

    def reviewed(self, identifier):
        self.m.add(self.root, self.candidate(identifier))
        for kind in self.m.REVIEWS[:5]:
            self.m.review(self.root, dict(hypothesis=identifier, kind=kind, decision='pass', rationale='protocol fixture'))

    def scheduled(self):
        self.reviewed('a')
        self.reviewed('b')
        self.m.graph(self.root, [dict(a='a', b='b', similarity=.9, rationale='fixture shared mechanism')])
        return self.m.pair(self.root)

    def result(self):
        return dict(**self.scheduled(), winner='a', rationale='fixture',
                    debate=[dict(speaker=x, content='fixture argument') for x in ['a','b','a','b']],
                    order_swapped_check='fixture comparison remained stable')

    def test_elo_and_idempotent_match(self):
        record = self.result()
        result = self.m.match(self.root, record)
        self.assertEqual(result['after'], dict(a=1216, b=1184))
        self.assertEqual(self.m.match(self.root, record), result)
        self.assertEqual(self.m.stats(self.root)['ranked'][0]['games'], 1)
        with self.assertRaises(ValueError):
            self.m.match(self.root, {**record, 'winner':'b'})

    def test_immutable_child_new_rating_and_parent_provenance(self):
        self.m.match(self.root, self.result())
        child = self.candidate('c'); child.update(source='evolution', parents=['a'], strategy='simplification')
        self.m.add(self.root, child)
        state = json.loads((self.root / 'pool.json').read_text())
        self.assertEqual(state['hypotheses']['c']['rating'],1200)
        self.assertEqual(state['hypotheses']['a']['rating'],1216)
        with self.assertRaises(ValueError):
            self.m.add(self.root, {**child, 'summary':'overwrite'})
        state['hypotheses']['a']['content']['summary']='tampered'
        (self.root/'pool.json').write_text(json.dumps(state))
        with self.assertRaises(ValueError):
            self.m.stats(self.root)

    def test_review_and_proximity_gates(self):
        self.m.add(self.root, self.candidate('a'))
        with self.assertRaises(ValueError):
            self.m.review(self.root,dict(hypothesis='a', kind='full', decision='pass', rationale='fixture'))
        with self.assertRaises(ValueError):
            self.m.pair(self.root)
        self.reviewed('a'); self.reviewed('b')
        with self.assertRaises(ValueError):
            self.m.pair(self.root)
        self.m.review(self.root,dict(hypothesis='a', kind='recurrent', decision='reject', rationale='fixture new contradiction'))
        self.assertEqual(self.m.stats(self.root)['filtered'], ['a'])

    def test_goal_change_invalidates_reviews_matches_graph_and_elo(self):
        record = self.result()
        self.m.replan(self.root, {**self.plan, 'goal':'changed'})
        self.assertEqual(self.m.stats(self.root)['ranked'], [])
        with self.assertRaises(ValueError):
            self.m.match(self.root,record)
        self.reviewed('a');self.reviewed('b')
        with self.assertRaises(ValueError):
            self.m.pair(self.root)

    def test_top_pair_requires_actual_multiturn_record(self):
        record = self.result();record['debate']=record['debate'][:2]
        with self.assertRaises(ValueError):
            self.m.match(self.root,record)
        self.assertEqual(self.m.stats(self.root)['ranked'][0]['games'],0)

    def test_feedback_persists_and_new_epoch_does_not_reuse_it(self):
        value=dict(recurring_issues=['fixture'],agent_feedback={'generation':'fixture'},research_overview='fixture',experiments=[],contacts=[])
        self.m.feedback(self.root,value)
        self.assertEqual(self.m.stats(self.root)['latest_feedback']['version'],1)
        self.m.replan(self.root,self.plan)
        self.assertIsNone(self.m.stats(self.root)['latest_feedback'])


class BiomniAtomicSteps(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m=module('biomni','bridge.py')
        try:
            cls.up=cls.m.upstream()
        except ImportError as e:
            raise unittest.SkipTest('Install Biomni core dependencies to execute A1 protocol tests: '+str(e))

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        # Test fixture only: no production data bypass and no network/model call.
        with patch.object(self.up,'get_llm',return_value=self.m.Relay()), contextlib.redirect_stdout(io.StringIO()):
            agent=self.up.A1(path=str(self.root/'data'),expected_data_lake_files=[])
            self.engine=self.m.Engine(self.root/'run',dict(task='local protocol fixture',self_critic=True,test_time_scale_round=1),agent=agent)
        self.n=0

    def request(self,request):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.engine.request(request)

    def respond(self,content):
        prompt=self.request(dict(action='prompt'));self.n+=1
        return self.request(dict(action='respond',id='r'+str(self.n),prompt_id=prompt['prompt_id'],response=content))

    def retrieve(self):
        prompt=self.request(dict(action='prompt'))
        self.assertIn('AVAILABLE TOOLS',str(prompt['messages']))
        self.respond('TOOLS: [0]\nDATA_LAKE: []\nLIBRARIES: [0]\nKNOW_HOW: [0]')
        self.assertEqual(self.engine.phase,'generate')
        selected=json.loads((self.root/'run/resources.json').read_text())
        self.assertEqual(len(selected['tools']),1)
        self.assertIn('content',selected['know_how'][0])

    def test_real_persistent_execution_retries_critic_and_export(self):
        self.retrieve()
        self.respond('<EXECUTE>scienceevolve_fixture_x = 40; print(scienceevolve_fixture_x)</EXECUTE>')
        request=dict(action='advance',id='exec-1')
        result=self.request(request)
        self.assertIn('40',result['last_message'])
        self.assertEqual(result,self.request(request))
        self.respond('<execute>scienceevolve_fixture_x += 2; print(scienceevolve_fixture_x)</execute>')
        result=self.request(dict(action='advance',id='exec-2'))
        self.assertIn('42',result['last_message'])
        self.respond('```bash\nprintf scienceevolve-shell-ok\n```')
        result=self.request(dict(action='advance',id='exec-bash'))
        self.assertIn('scienceevolve-shell-ok',result['last_message'])
        self.respond('<solution>fixture initial solution</solution>')
        self.assertEqual(self.engine.phase,'critic')
        self.respond('Fixture critique: check the persisted result.')
        self.assertEqual(self.engine.agent.critic_count,1)
        self.respond('<solution>fixture revised solution</solution>')
        self.request(dict(action='advance',id='critic-end'))
        self.assertEqual(self.engine.phase,'end')
        self.request(dict(action='export',id='report',pdf=False))
        self.assertTrue((self.root/'run/conversation.md').is_file())
        self.assertFalse((self.root/'run/inflight.json').exists())

    def test_stale_prompt_does_not_advance_and_dead_interpreter_not_replayed(self):
        prompt=self.request(dict(action='prompt'))
        with self.assertRaises(ValueError):
            self.request(dict(action='respond',id='stale',prompt_id='wrong',response='fixture'))
        self.assertEqual(prompt,self.request(dict(action='prompt')))
        with self.assertRaises(RuntimeError):
            self.m.Engine(self.root/'run',dict(task='fixture'),agent=self.engine.agent)

    def test_production_rejects_missing_data(self):
        with self.assertRaises(ValueError):
            self.m.check_data(self.up,self.root/'missing',False)


class ArchiveIO(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.m=module('agentrxiv','archive.py')

    def test_real_http_publish_verify_search_fulltext_and_retry(self):
        try:
            import PyPDF2
            from PyPDF2.generic import DictionaryObject, NameObject, DecodedStreamObject
        except ImportError as e:
            self.skipTest('PDF IO dependencies required: '+str(e))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);uploads=root/'uploads';uploads.mkdir()
            pdf=root/'report.pdf'
            writer=PyPDF2.PdfWriter();writer.add_blank_page(width=600,height=800);page=writer.pages[0]
            font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
            page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
            stream=DecodedStreamObject();stream.set_data(b'BT /F1 12 Tf 50 700 Td (Fixture scientific report full text.) Tj ET')
            page[NameObject('/Contents')]=writer._add_object(stream)
            with pdf.open('wb') as file:writer.write(file)
            class Handler(BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def do_GET(self):
                    if self.path.startswith('/api/search'):
                        data=json.dumps(dict(results=[dict(id=i,filename=p.name,similarity=1.,pdf_url=f'http://127.0.0.1:{self.server.server_port}/uploads/{p.name}') for i,p in enumerate(sorted(uploads.glob('*.pdf')),1)])).encode()
                    elif self.path=='/update':data=b'{}'
                    elif self.path.startswith('/uploads/'):data=(uploads/self.path.split('/')[-1]).read_bytes()
                    else:self.send_error(404);return
                    self.send_response(200);self.end_headers();self.wfile.write(data)
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            env=patch.dict(os.environ,{'no_proxy':'127.0.0.1','NO_PROXY':'127.0.0.1'})
            env.start()
            try:
                url=f'http://127.0.0.1:{server.server_port}'
                receipt=self.m.publish(url,uploads,pdf,'lab-a',1,root/'cache')
                self.assertEqual(receipt,self.m.publish(url,uploads,pdf,'lab-a',1,root/'cache'))
                self.assertEqual(len(list(uploads.glob('*.pdf'))),1)
                found=self.m.search(url,'fixture',root/'cache')
                self.assertEqual(found[0]['sha256'],receipt['sha256'])
                self.assertIn('Fixture scientific report',Path(found[0]['fulltext']).read_text())
                self.assertEqual(found[0]['source'],'AgentRxiv:1')
            finally:
                env.stop()
                server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
