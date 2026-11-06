"""Core contracts: no material prerequisite, immutable inputs, idempotency and review before TTS."""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch, Mock

import app
import broadcast
import harness
import store

CONFIG = {'project_id':'example-project','llm_model':'test-model','llm_location':'global',
          'tts_model':'test-tts','lyria_model':'test-music','lyria_location':'global'}


def sample_plan(search=False):
    return {'interpretation':'英语基础，室友趣事，轻松幽默。','topic':'冰箱的误会','angle':'蛋糕被误吃',
            'structure':['读信','讨论','回扣'],'expressions':['I assumed','it turns out'],
            'needs_search':search,'search_queries':['official travel advice'] if search else [],
            'listening_support':'用简单话复述','voice_direction':'Warm, clearly paced conversation.'}


def sample_episode(ja=False):
    if ja:
        line='今日は架空のおたよりです。友達と一緒に、小さな生活の話を楽しみましょう。なるほど、そうですね。' * 3
    else:
        line='I assumed we could share the food, but it turns out the cake was special. The letter was fictional and the two friends had a small surprise. The name on the cake was a clue, but the hungry friend did not notice it.'
    return {'title':'冰箱里的生日蛋糕','summary':'室友误吃了有名字的蛋糕，讨论共享食物的边界。',
            'turns':[{'speaker':'Host' if i%2==0 else 'Guest','text':line} for i in range(8)]}


def reply(value):
    return {'text':json.dumps(value,ensure_ascii=False),'model_version':'test-model',
            'sources':[],'grounding':{},'search_suggestions':''}


class HarnessTests(unittest.TestCase):
    def test_no_materials_generates_persistable_script_with_bounded_review(self):
        checkpoints=[];phases=[]
        with patch('harness._request',side_effect=[reply(sample_plan()),reply(sample_episode()),reply({'passed':True,'issues':[]})]) as request:
            result=harness.generate({'language':'en','difficulty':'basic','length':'BRIEF','wish':'室友趣事','episodes':[]},CONFIG,'温暖一点',phases.append,checkpoints.append)
        self.assertIn('Host:',result['script'])
        self.assertEqual(result['sources'],[])
        self.assertEqual(phases,['plan','script','review'])
        self.assertIn('温暖一点',request.call_args_list[0].args[1])
        self.assertEqual(result['harness_version'],harness.VERSION)

    def test_search_without_real_sources_stops_before_script(self):
        with patch('harness._request',side_effect=[reply(sample_plan(True)),{'text':'unsourced answer','sources':[]}]) as request:
            with self.assertRaisesRegex(RuntimeError,'没有返回可追溯来源'):
                harness.generate({'language':'en','difficulty':'basic'},CONFIG,'',lambda p:None,lambda p:None)
        self.assertEqual(request.call_count,2)

    def test_rejected_script_has_only_one_revision_and_never_returns_for_tts(self):
        rejection=reply({'passed':False,'issues':['节目变成要求用户跟读的练习']})
        with patch('harness._request',side_effect=[reply(sample_plan()),reply(sample_episode()),rejection,reply(sample_episode()),rejection]) as request:
            with self.assertRaisesRegex(ValueError,'内容检查未通过'):
                harness.generate({'language':'en','difficulty':'basic','length':'BRIEF'},CONFIG,'',lambda p:None,lambda p:None)
        self.assertEqual(request.call_count,5)

    def test_wrong_language_and_missing_recurrence_are_caught(self):
        english=sample_episode()
        self.assertTrue(any('日语' in s for s in harness.validate_episode(english,'ja',(100,2000),[])))
        self.assertTrue(any('出现至少两次' in s for s in harness.validate_episode(english,'en',(100,2000),['never occurs'])))
        self.assertEqual(harness.validate_episode(sample_episode(True),'ja',(350,1200),['なるほど','そうですね']),[])

    def test_history_contains_only_prior_finished_content_not_pending_or_mastery(self):
        history=harness.recent_context({'episodes':[{'status':'generating','summary':'do not use'},
             {'status':'ready','summary':'previous plot','expressions':['old phrase'],'mastered':True}]})
        self.assertEqual(len(history),1)
        self.assertNotIn('mastered',history[0])
        self.assertEqual(history[0]['expressions'],['old phrase'])

    def test_japanese_inflections_and_reading_annotations_do_not_force_unnatural_repetition(self):
        draft=sample_episode(True)
        for turn in draft['turns']:
            turn['text']+=' その時、心からホッとしました。'
        draft['expression_forms']={'ホッとする':['ホッとしました']}
        self.assertEqual(harness.validate_episode(draft,'ja',(1,2000),['ホッとする']),[])
        self.assertEqual(harness._expression('湯船につかる（ゆぶねにつかる）'),'湯船につかる')
        for i,turn in enumerate(draft['turns']):
            if i:turn['text']=turn['text'].replace('ホッとしました','安心しました')
        draft['expression_forms']={'ホッとする':['ホッとしました','ホッとし']}
        self.assertTrue(any('至少两次' in issue for issue in harness.validate_episode(draft,'ja',(1,2000),['ホッとする'])))

    def test_retry_reuses_real_sources_and_plan_without_researching(self):
        research={'text':'Verified background.','sources':[{'title':'Official','url':'https://example.org'}], 'grounding':{},'search_suggestions':'<div>Search</div>'}
        resume={'plan':sample_plan(True),'research':research,'draft':sample_episode()}
        with patch('harness._request',side_effect=[reply(sample_episode()),reply({'passed':True,'issues':[]})]) as request:
            result=harness.generate({'language':'en','difficulty':'basic','length':'BRIEF'},CONFIG,'',lambda p:None,lambda p:None,resume=resume)
        self.assertEqual(request.call_count,2)
        self.assertEqual(result['research'],research)


class ChannelTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.previous=os.environ.get('DIYFM_DATA')
        os.environ['DIYFM_DATA']=self.tmp.name;self.client=app.app.test_client()
        self.config=patch('broadcast.config_snapshot',return_value=dict(CONFIG));self.config.start()
        broadcast._jobs.clear()

    def tearDown(self):
        broadcast._jobs.clear();self.config.stop()
        if self.previous is None:os.environ.pop('DIYFM_DATA',None)
        else:os.environ['DIYFM_DATA']=self.previous
        self.tmp.cleanup()

    def channel(self):
        r=self.client.post('/api/shows',json={'language':'ja','difficulty':'basic','wish':'職場の話','length':'BRIEF'})
        self.assertEqual(r.status_code,200)
        return r.get_json()['show']

    def saved_episode(self, show_id, episode_id):
        store.save_episode(show_id, {'id':episode_id,'title':episode_id,'status':'ready'}, b'wave data')
        (Path(self.tmp.name) / 'audio' / f'{episode_id}.mp3').write_bytes(b'mp3 data')

    def test_delete_episode_removes_files_but_retains_channel_preferences_and_other_results(self):
        show=self.channel();other=self.channel()
        self.saved_episode(show['id'],'delete_me');self.saved_episode(show['id'],'keep_me')
        self.saved_episode(other['id'],'other_result')
        wrong=self.client.delete(f"/api/shows/{other['id']}/episodes/delete_me")
        self.assertEqual(wrong.status_code,404)
        result=self.client.delete(f"/api/shows/{show['id']}/episodes/delete_me")
        self.assertEqual(result.status_code,200)
        saved=result.get_json()['show']
        self.assertEqual(saved['wish'],show['wish'])
        self.assertEqual(saved['revision'],show['revision']+1)
        self.assertEqual([e['id'] for e in saved['episodes']],['keep_me'])
        for ext in ('.wav','.mp3'):
            self.assertFalse((Path(self.tmp.name)/'audio'/f'delete_me{ext}').exists())
            self.assertTrue((Path(self.tmp.name)/'audio'/f'keep_me{ext}').exists())
            self.assertTrue((Path(self.tmp.name)/'audio'/f'other_result{ext}').exists())
        self.assertIsNone(store.find_episode('delete_me'))
        self.assertEqual(self.client.get('/api/episodes/delete_me/audio').status_code,404)
        self.assertEqual(self.client.delete(f"/api/shows/{show['id']}/episodes/delete_me").status_code,404)

    def test_delete_channel_removes_its_results_only_and_refuses_active_production(self):
        show=self.channel();other=self.channel()
        self.saved_episode(show['id'],'delete_me');self.saved_episode(other['id'],'keep_me')
        broadcast._jobs.add(show['id'])
        self.assertEqual(self.client.delete(f"/api/shows/{show['id']}").status_code,409)
        self.assertEqual(self.client.delete(f"/api/shows/{show['id']}/episodes/delete_me").status_code,409)
        self.assertIsNotNone(store.audio_path('delete_me'))
        broadcast._jobs.clear()
        self.assertEqual(self.client.delete(f"/api/shows/{show['id']}").status_code,200)
        self.assertIsNone(store.get_show(show['id']))
        self.assertIsNotNone(store.get_show(other['id']))
        self.assertIsNone(store.audio_path('delete_me'))
        self.assertTrue((Path(self.tmp.name)/'audio'/'keep_me.mp3').exists())

    def test_delete_write_failure_restores_both_metadata_and_audio(self):
        show=self.channel();self.saved_episode(show['id'],'retained')
        for delete in (lambda:store.delete_episode(show['id'],'retained'), lambda:store.delete_show(show['id'])):
            with patch('store._write',side_effect=OSError('disk failure')):
                with self.assertRaisesRegex(OSError,'disk failure'):
                    delete()
            self.assertIsNotNone(store.find_episode('retained'))
            for ext in ('.wav','.mp3'):
                self.assertTrue((Path(self.tmp.name)/'audio'/f'retained{ext}').exists())
            self.assertEqual(list((Path(self.tmp.name)/'audio').glob('.*.deleting-*')),[])

    def test_delete_rejects_active_mp3_export_then_removes_files_after_export(self):
        show=self.channel();self.saved_episode(show['id'],'converting')
        started=threading.Event();release=threading.Event()
        def convert(episode_id):
            started.set()
            if not release.wait(2):
                raise RuntimeError('test export timed out')
            path=Path(self.tmp.name)/'audio'/f'{episode_id}.mp3'
            path.write_bytes(b'new mp3')
            return path
        with patch('store._ensure_mp3_locked',side_effect=convert):
            exporting=threading.Thread(target=store.ensure_mp3,args=('converting',))
            exporting.start()
            try:
                self.assertTrue(started.wait(1))
                for url in (f"/api/shows/{show['id']}",f"/api/shows/{show['id']}/episodes/converting"):
                    result=self.client.delete(url)
                    self.assertEqual(result.status_code,409)
                    self.assertIn('正在准备下载',result.get_json()['message'])
                self.assertIsNotNone(store.audio_path('converting'))
            finally:
                release.set();exporting.join(2)
        self.assertFalse(exporting.is_alive())
        self.assertIsNotNone(store.delete_episode(show['id'],'converting'))
        self.assertIsNone(store.audio_path('converting'))
        self.assertFalse((Path(self.tmp.name)/'audio'/'converting.mp3').exists())

    def test_generation_needs_no_materials_and_retry_joins_same_request(self):
        s=self.channel()
        with patch('broadcast.threading.Thread') as thread:
            first=self.client.post(f"/api/shows/{s['id']}/episodes",json={'request_id':'request_1234','episode_wish':'温暖一点','revision':0})
            second=self.client.post(f"/api/shows/{s['id']}/episodes",json={'request_id':'request_1234'})
            other=self.client.post(f"/api/shows/{s['id']}/episodes",json={'request_id':'request_9999'})
        self.assertEqual(first.status_code,200);self.assertEqual(second.status_code,200)
        self.assertEqual(first.get_json()['episode']['id'],second.get_json()['episode']['id'])
        self.assertEqual(other.status_code,409)
        self.assertEqual(thread.call_count,1)
        self.assertEqual(store.get_show(s['id'])['wish'],'職場の話')

    def test_first_episode_uses_voice_and_music_choices_from_creation(self):
        choices={'host_voice':'Zephyr','guest_voice':'Charon','music_style':'night_drive'}
        response=self.client.post('/api/shows',json={'language':'en','wish':'室友来信',**choices})
        self.assertEqual(response.status_code,200)
        show=response.get_json()['show']
        for key,value in choices.items():self.assertEqual(show[key],value)
        with patch('broadcast.threading.Thread') as thread:
            result=self.client.post(f"/api/shows/{show['id']}/episodes",json={'request_id':'first_sound_123','revision':0})
        self.assertEqual(result.status_code,200)
        args=thread.call_args.kwargs['args']
        for key,value in choices.items():
            self.assertEqual(args[3][key],value)
            self.assertEqual(args[4][key],value)

    def test_same_voices_are_rejected_before_channel_is_created(self):
        response=self.client.post('/api/shows',json={'host_voice':'Puck','guest_voice':'Puck'})
        self.assertEqual(response.status_code,400)
        self.assertEqual(store.list_shows(),[])

    def test_task_owns_inputs_even_if_channel_changes_after_submit(self):
        s=self.channel()
        with patch('broadcast.threading.Thread') as thread:
            self.client.post(f"/api/shows/{s['id']}/episodes",json={'request_id':'snapshot_123','episode_wish':'仅本期'})
            args=thread.call_args.kwargs['args']
            store.update_show(s['id'],{'wish':'later','language':'en'})
        self.assertEqual(args[3]['wish'],'職場の話')
        self.assertEqual(args[3]['language'],'ja')
        self.assertEqual(args[4]['episode_wish'],'仅本期')

    def test_stale_generation_or_preference_write_is_rejected(self):
        s=self.channel();store.update_show(s['id'],{'wish':'another window'})
        with patch('broadcast.threading.Thread') as thread:
            r=self.client.post(f"/api/shows/{s['id']}/episodes",json={'revision':0})
        self.assertEqual(r.status_code,409);thread.assert_not_called()
        r=self.client.patch(f"/api/shows/{s['id']}",json={'revision':'invalid','wish':'overwrite'})
        self.assertEqual(r.status_code,400)
        self.assertEqual(store.get_show(s['id'])['wish'],'another window')

    def test_invalid_input_is_rejected_before_creating_or_starting(self):
        for body in ({'language':'fr'},{'language':[]},{'difficulty':'expert'},{'wish':'x'*1201},[]):
            self.assertEqual(self.client.post('/api/shows',json=body).status_code,400)
        self.assertEqual(store.list_shows(),[])
        s=self.channel()
        with patch('broadcast.threading.Thread') as thread:
            r=self.client.post(f"/api/shows/{s['id']}/episodes",json={'episode_wish':'x'*601})
        self.assertEqual(r.status_code,400);thread.assert_not_called()

    def test_retry_keeps_original_direction_and_does_not_change_channel_preferences(self):
        s=self.channel()
        original={**s,'episode_wish':'原来这期的口味'}
        store.mark_episode(s['id'],{'id':'ep_retry','status':'failed','input':original,'config':CONFIG})
        store.update_show(s['id'],{'language':'en','wish':'new direction'})
        with patch('broadcast.threading.Thread') as thread:
            response=self.client.post(f"/api/shows/{s['id']}/episodes",json={'request_id':'retry_request','retry_episode_id':'ep_retry','revision':1})
        self.assertEqual(response.status_code,200)
        args=thread.call_args.kwargs['args']
        self.assertEqual(args[3]['language'],'ja')
        self.assertEqual(args[4]['episode_wish'],'原来这期的口味')
        self.assertEqual(store.get_show(s['id'])['wish'],'new direction')

    def test_retry_checked_transcript_does_not_call_llm_again(self):
        s=self.channel()
        source={'id':'ep_original','status':'failed','script':'Host: Hello\nGuest: Hi','review':{'passed':True,'issues':[]},
                'title':'原节目','plan':{'voice_direction':'Warm'},'summary':'original'}
        store.mark_episode(s['id'],{'id':'ep_retry_voice','status':'generating'})
        with patch('broadcast.harness.generate') as generate,patch('broadcast.fm_synth._synthesize_fm_dialogue_pcm',return_value=b'\0'*48000),patch('broadcast.fm_synth.resolve_fm_bgm_pcm',side_effect=RuntimeError('no music')):
            broadcast._run(s['id'],'ep_retry_voice',CONFIG,store.get_show(s['id']),{'episode_wish':''},resume=source)
        generate.assert_not_called()
        self.assertEqual(store.find_episode('ep_retry_voice')[1]['status'],'ready')
        self.assertEqual(store.find_episode('ep_retry_voice')[1]['script'],source['script'])

    def test_full_worker_saves_transcript_and_falls_back_to_speech_without_losing_result(self):
        s=self.channel();epid='ep_integration'
        pending={'id':epid,'request_id':'complete_request','status':'generating','created_at':'2026-11-05T10:00:00','config':CONFIG,'input':{'wish':'original'}}
        store.mark_episode(s['id'],pending)
        content={'title':'测试来信','summary':'独立故事','script':'Host: Hello\nGuest: Hi','turns':[],
                 'plan':{'voice_direction':'Warm'},'expressions':['Hello'],'sources':[],
                 'research':{'text':'','sources':[],'search_suggestions':''},'harness_version':harness.VERSION}
        with patch('broadcast.harness.generate',return_value=content),patch('broadcast.fm_synth._synthesize_fm_dialogue_pcm',return_value=b'\0'*48000),patch('broadcast.fm_synth.resolve_fm_bgm_pcm',side_effect=RuntimeError('no music')):
            broadcast._run(s['id'],epid,CONFIG,store.get_show(s['id']),{'episode_wish':'one off'})
        saved=store.find_episode(epid)[1]
        self.assertEqual(saved['status'],'ready');self.assertEqual(saved['music_source'],'skipped')
        self.assertTrue(store.audio_path(epid).exists())
        public=self.client.get('/api/shows').get_json()['shows'][0]['episodes'][0]
        self.assertNotIn('script',public);self.assertNotIn('research',public);self.assertTrue(public['has_script'])
        transcript=self.client.get(f'/api/episodes/{epid}/transcript').get_json()
        self.assertEqual(transcript['script'],content['script'])
        with patch('broadcast.threading.Thread') as thread:
            again=self.client.post(f"/api/shows/{s['id']}/episodes",json={'request_id':'complete_request'})
        self.assertEqual(again.get_json()['episode']['status'],'ready');thread.assert_not_called()

    def test_failed_voice_keeps_checked_script_and_old_ready_audio(self):
        s=self.channel();store.save_episode(s['id'],{'id':'ep_old','status':'ready'},b'RIFFold')
        store.mark_episode(s['id'],{'id':'ep_failure','status':'generating'})
        content={'title':'new','script':'Host: Hello','plan':{}}
        with patch('broadcast.harness.generate',return_value=content),patch('broadcast.fm_synth._synthesize_fm_dialogue_pcm',side_effect=RuntimeError('voice unavailable')):
            broadcast._run(s['id'],'ep_failure',CONFIG,store.get_show(s['id']),{'episode_wish':''})
        self.assertEqual(store.find_episode('ep_failure')[1]['status'],'failed')
        self.assertEqual(store.find_episode('ep_failure')[1]['script'],'Host: Hello')
        self.assertEqual(store.audio_path('ep_old').read_bytes(),b'RIFFold')

    def test_old_library_is_read_without_erasing_materials_or_audio(self):
        old={'id':'old_show','title':'old','materials':[{'id':'m','text':'keep'}],'episodes':[{'id':'ep_old','status':'ready'}]}
        path=Path(self.tmp.name)/'shows.json';path.write_text(json.dumps({'shows':[old]}))
        before=path.read_bytes();loaded=store.get_show('old_show')
        self.assertEqual(loaded['language'],'en');self.assertEqual(loaded['materials'],old['materials'])
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(self.client.get('/api/episodes/ep_old/transcript').status_code,404)

    def test_corrupt_library_is_not_silently_overwritten(self):
        path=Path(self.tmp.name)/'shows.json';path.write_text('{broken')
        with self.assertRaises(RuntimeError):store.create_show('new')
        self.assertEqual(path.read_text(),'{broken')


if __name__=='__main__':unittest.main()
