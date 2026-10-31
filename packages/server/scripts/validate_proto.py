#!/usr/bin/env python3
"""Compile comty.proto, verify every route/event in its descriptor, and round-trip data.
Install optional validator dependencies: python -m pip install -r scripts/proto-requirements.txt
"""
import argparse
import importlib.util
import json
import pathlib
import tempfile
from collections import Counter

from google.protobuf import descriptor_pb2
from grpc_tools import protoc
import grpc_tools


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--proto', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1] / 'docs/proto/comty.proto')
    args = parser.parse_args()
    proto = args.proto.resolve()
    coverage = json.loads(proto.with_suffix('.coverage.json').read_text())
    assert grpc_tools.__file__ is not None
    include = pathlib.Path(grpc_tools.__file__).parent / '_proto'
    with tempfile.TemporaryDirectory(prefix='comty-proto-validation-') as temporary:
        directory = pathlib.Path(temporary)
        descriptor = directory / 'comty.pb'
        code = protoc.main(['protoc', f'-I{proto.parent}', f'-I{include}', f'--python_out={directory}', f'--descriptor_set_out={descriptor}', '--include_imports', str(proto)])
        if code:
            raise SystemExit(code)
        module_name = proto.stem + '_pb2'
        module_file = directory / (module_name + '.py')
        spec = importlib.util.spec_from_file_location(module_name, module_file)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        file_set = descriptor_pb2.FileDescriptorSet.FromString(descriptor.read_bytes())
        contract = next(f for f in file_set.file if f.name == proto.name)
        assert len(contract.message_type) == coverage['counts']['messages']
        assert len(contract.service) == coverage['counts']['services']
        expected = Counter()
        for key in ('httpRoutes', 'wsEvents'):
            for route in coverage[key]:
                expected[(route['method'], route['path'], route['source'])] += 1
        actual = Counter()
        for service in contract.service:
            for method in service.method:
                options = method.options
                source = options.Extensions[module.source_file]
                if options.HasExtension(module.http_method):
                    key = (options.Extensions[module.http_method], options.Extensions[module.http_path], source)
                else:
                    assert options.HasExtension(module.ws_event), method.name
                    key = ('WS', options.Extensions[module.ws_event], source)
                actual[key] += 1
                assert not method.client_streaming and not method.server_streaming, method.name
        assert actual == expected, f'Missing: {expected-actual}; unexpected: {actual-expected}'
        # Values are local fixtures, not fabricated API responses.
        login = module.AuthPOSTAuthBody(username='', password='local_fixture')
        restored = module.AuthPOSTAuthBody.FromString(login.SerializeToString())
        assert restored.username == '' and restored.HasField('username')
        assert not restored.HasField('mfa_code')
        dynamic = module.AuthPOSTAuthRequest()
        dynamic.query.update({'list': [1, True, None], 'nested': {'key': 'value'}})
        assert module.AuthPOSTAuthRequest.FromString(dynamic.SerializeToString()) == dynamic
        manifest = json.loads(proto.with_suffix('.tags.json').read_text())
        for message in contract.message_type:
            for field in message.field:
                original_name = field.json_name
                if original_name not in manifest[message.name]:
                    original_name = field.name
                assert field.number == manifest[message.name][original_name]['number']
        proto.with_suffix('.pb').write_bytes(descriptor.read_bytes())
        print(f'OK: {len(contract.message_type)} messages, {len(contract.service)} services, {sum(actual.values())} RPCs; full inventory matches descriptor.')
        print('OK: scalar presence and dynamic JSON binary round-trips; manifest tags match compiled fields.')
        print(f'Descriptor: {proto.with_suffix(".pb")}')


if __name__ == '__main__':
    main()
