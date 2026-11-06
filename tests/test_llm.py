import unittest
from unittest.mock import patch, Mock
import llm


class LLMAdapterTests(unittest.TestCase):
    def session(self, payload, status=200):
        response=Mock(ok=status==200,status_code=status)
        response.json.return_value=payload
        session=Mock();session.__enter__=Mock(return_value=session);session.__exit__=Mock(return_value=False)
        session.post.return_value=response
        return session

    def invoke(self, session, **kwargs):
        with patch('google.auth.default',return_value=(Mock(),None)),patch('google.auth.transport.requests.AuthorizedSession',return_value=session):
            return llm.call_llm_result({'projectId':'example-project','location':'global','modelId':'test-model',**kwargs},'hello')

    def test_search_is_sent_and_only_provider_sources_are_saved(self):
        s=self.session({'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':'Answer'},{'text':'internal reasoning','thought':True}]},
             'groundingMetadata':{'groundingChunks':[{'web':{'uri':'https://example.org/source','title':'Source'}},{'web':{'uri':'javascript:bad','title':'invalid'}}],
                                  'searchEntryPoint':{'renderedContent':'<div>Google search suggestions</div>'}}}],'modelVersion':'actual-version'})
        r=self.invoke(s,useWebSearch=True)
        request=s.post.call_args
        self.assertTrue(request.args[0].startswith('https://aiplatform.googleapis.com/'))
        self.assertEqual(request.kwargs['json']['tools'],[{'googleSearch':{}}])
        self.assertEqual(r['text'],'Answer');self.assertEqual(len(r['sources']),1)
        self.assertIn('suggestions',r['search_suggestions']);self.assertEqual(r['model_version'],'actual-version')
        self.assertEqual(request.kwargs['timeout'],(15,240))

    def test_provider_limit_is_actionable_and_not_silently_retried_or_switched(self):
        s=self.session({},429)
        with self.assertRaisesRegex(RuntimeError,'429'):
            self.invoke(s)
        self.assertEqual(s.post.call_count,1)

    def test_truncated_output_does_not_enter_script_pipeline(self):
        s=self.session({'candidates':[{'finishReason':'MAX_TOKENS','content':{'parts':[{'text':'partial'}]}}]})
        with self.assertRaisesRegex(RuntimeError,'未完成'):
            self.invoke(s,json=True)
        self.assertEqual(s.post.call_args.kwargs['json']['generationConfig']['responseMimeType'],'application/json')

    def test_auth_transport_error_is_reported_as_network_not_login_failure(self):
        from google.auth.exceptions import TransportError
        s=self.session({});s.post.side_effect=TransportError('no route')
        with self.assertRaisesRegex(RuntimeError,'无法连接 Google 鉴权服务'):
            self.invoke(s)


if __name__=='__main__':unittest.main()
