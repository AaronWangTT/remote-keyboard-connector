import os
from pathlib import Path
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def prepare_test_key(path):
    path = Path(path)
    if not path.exists():
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        data = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                 serialization.NoEncryption())
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size != 3072:
        raise ValueError("The local OTA test key must be RSA-3072")


if __name__ == "__main__":
    prepare_test_key(sys.argv[1])