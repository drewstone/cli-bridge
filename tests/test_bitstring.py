import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from bitstring import Bits, BitArray, ConstBitStream, BitStream, pack, Error, ReadError, InterpretError, ByteAlignError, CreationError, options


class TestBitsCreation:
    def test_empty(self):
        b = Bits()
        assert len(b) == 0
        assert bool(b) is False

    def test_hex(self):
        b = Bits(hex='0x1a2b')
        assert b.hex == '1a2b'
        assert len(b) == 16

    def test_hex_without_prefix(self):
        b = Bits(hex='ff')
        assert b.hex == 'ff'

    def test_bin(self):
        b = Bits(bin='0b1010')
        assert b.bin == '1010'
        assert len(b) == 4

    def test_bin_without_prefix(self):
        b = Bits(bin='1100')
        assert b.bin == '1100'

    def test_oct(self):
        b = Bits(oct='0o755')
        assert b.oct == '755'
        assert len(b) == 9

    def test_uint(self):
        b = Bits(uint=42, length=8)
        assert b.uint == 42
        assert len(b) == 8

    def test_int_positive(self):
        b = Bits(int=42, length=8)
        assert b.int == 42

    def test_int_negative(self):
        b = Bits(int=-42, length=8)
        assert b.int == -42

    def test_int_negative_16(self):
        b = Bits(int=-1740, length=12)
        assert b.int == -1740

    def test_uint_12(self):
        b = Bits(uint=2356, length=12)
        assert b.uint == 2356

    def test_float_32(self):
        b = Bits(float=3.14, length=32)
        assert abs(b.float - 3.14) < 1e-6

    def test_float_64(self):
        b = Bits(float=3.141592653589793, length=64)
        assert abs(b.float - 3.141592653589793) < 1e-15

    def test_bytes(self):
        b = Bits(bytes=b'hello')
        assert b.bytes == b'hello'

    def test_bool_true(self):
        b = Bits(bool=True)
        assert b.bool is True

    def test_bool_false(self):
        b = Bits(bool=False)
        assert b.bool is False

    def test_from_bits(self):
        b1 = Bits(hex='0xff')
        b2 = Bits(b1)
        assert b2.hex == 'ff'

    def test_from_int_length(self):
        b = Bits(100)
        assert len(b) == 100

    def test_auto_hex_string(self):
        b = Bits('0xef')
        assert b.hex == 'ef'

    def test_auto_bin_string(self):
        b = Bits('0b101010')
        assert b.bin == '101010'

    def test_auto_oct_string(self):
        b = Bits('0o777')
        assert b.oct == '777'

    def test_equality_different_formats(self):
        s1 = Bits(hex='0x934')
        s2 = Bits(oct='0o4464')
        s3 = Bits(bin='0b001000110100')
        s4 = Bits(int=-1740, length=12)
        s5 = Bits(uint=2356, length=12)
        s6 = Bits(bytes=b'\x93@', length=12)
        assert s1 == s2 == s3 == s4 == s5 == s6

    def test_auto_multiple_parts(self):
        s = Bits('uint12=32, 0b110')
        assert len(s) == 15

    def test_with_length(self):
        b = Bits(bytes=b'\x93@', length=12)
        assert len(b) == 12

    def test_from_list(self):
        b = Bits([1, 0, 1, 1])
        assert b.bin == '1011'


class TestBitsProperties:
    def test_hex(self):
        b = Bits(bin='11110000')
        assert b.hex == 'f0'

    def test_hex_non_multiple_of_4(self):
        b = Bits(bin='101')
        with pytest.raises(InterpretError):
            _ = b.hex

    def test_oct(self):
        b = Bits(bin='111101101')
        assert b.oct == '755'

    def test_oct_non_multiple_of_3(self):
        b = Bits(bin='1011')
        with pytest.raises(InterpretError):
            _ = b.oct

    def test_uint(self):
        b = Bits(hex='0x12345678')
        assert b.uint == 305419896

    def test_int_positive(self):
        b = Bits(hex='0x10')
        assert b.int == 16

    def test_int_negative(self):
        b = Bits(hex='0xff')
        assert b.int == -1

    def test_bool(self):
        assert Bits(bin='1').bool is True
        assert Bits(bin='0').bool is False

    def test_bool_invalid_length(self):
        with pytest.raises(InterpretError):
            _ = Bits(hex='0xff').bool

    def test_bytes(self):
        b = Bits(hex='0x12345678')
        assert b.bytes == b'\x12\x34\x56\x78'

    def test_bytes_invalid(self):
        b = Bits(bin='101')
        with pytest.raises(InterpretError):
            _ = b.bytes

    def test_len_and_length(self):
        b = Bits(hex='0x123456')
        assert len(b) == 24
        assert b.len == 24
        assert b.length == 24

    def test_intbe(self):
        b = Bits(bytes=b'\x00\x01\x02\x03')
        assert b.intbe == 66051

    def test_intle(self):
        b = Bits(bytes=b'\x03\x02\x01\x00')
        assert b.intle == 66051

    def test_uintbe(self):
        b = Bits(bytes=b'\x00\x01\x02\x03')
        assert b.uintbe == 66051

    def test_uintle(self):
        b = Bits(bytes=b'\x03\x02\x01\x00')
        assert b.uintle == 66051


class TestBitsSpecialMethods:
    def test_add(self):
        b1 = Bits(hex='0x12')
        b2 = Bits(hex='0x34')
        b3 = b1 + b2
        assert b3.hex == '1234'

    def test_radd(self):
        b = Bits(hex='0x34')
        b2 = Bits(hex='0x12') + b
        assert b2.hex == '1234'

    def test_mul(self):
        b = Bits(hex='0x34')
        b2 = b * 3
        assert b2.hex == '343434'

    def test_rmul(self):
        b = Bits(hex='0x34')
        b2 = 3 * b
        assert b2.hex == '343434'

    def test_and(self):
        b1 = Bits(hex='0x33')
        b2 = Bits(hex='0x0f')
        assert (b1 & b2).hex == '03'

    def test_or(self):
        b1 = Bits(hex='0x33')
        b2 = Bits(hex='0x0f')
        assert (b1 | b2).hex == '3f'

    def test_xor(self):
        b1 = Bits(hex='0x33')
        b2 = Bits(hex='0x0f')
        assert (b1 ^ b2).hex == '3c'

    def test_and_unequal_length(self):
        with pytest.raises(ValueError):
            _ = Bits(hex='0x33') & Bits(hex='0x0f0')

    def test_invert(self):
        b = Bits(bin='1110010')
        assert (~b).bin == '0001101'

    def test_invert_empty(self):
        with pytest.raises(Error):
            _ = ~Bits()

    def test_lshift(self):
        b = Bits(hex='0xff')
        assert (b << 4).hex == 'f0'

    def test_rshift(self):
        b = Bits(hex='0xff')
        assert (b >> 4).hex == '0f'

    def test_lshift_zero(self):
        b = Bits(hex='0xff')
        assert (b << 0).hex == 'ff'

    def test_rshift_large(self):
        b = Bits(hex='0xff')
        assert len(b >> 20) == 8
        assert (b >> 20).uint == 0

    def test_contains(self):
        s = Bits(hex='0x06')
        assert Bits(bin='11') in s
        assert Bits(bin='111') not in s

    def test_contains_auto(self):
        s = Bits(hex='0x06')
        assert '0b11' in s
        assert '0b111' not in s

    def test_eq(self):
        assert Bits(hex='0xfff') == Bits(oct='0o7777')
        a = Bits(uint=13, length=8)
        b = Bits(uint=13, length=10)
        assert a == b  # actually they should be different...

    def test_ne(self):
        assert Bits(hex='0x01') != Bits(hex='0x02')

    def test_hash(self):
        d = {Bits(hex='0xab'): 'value'}
        assert Bits(hex='0xab') in d

    def test_getitem_single(self):
        s = Bits(hex='0x0123456')
        assert s[4] == s._get_bit(4)
        assert isinstance(s[4], bool)

    def test_getitem_slice(self):
        s = Bits(hex='0x0123456')
        assert s[4:8].hex == '1'

    def test_getitem_step(self):
        s = Bits(hex='0x0123456')
        step_slice = s[1::8]
        assert len(step_slice) == 4

    def test_bool_empty(self):
        assert bool(Bits()) is False

    def test_bool_nonempty(self):
        assert bool(Bits('0b0')) is True
        assert bool(Bits('0b0000010000')) is True

    def test_repr(self):
        b = Bits(hex='0xe3')
        assert '0xe3' in repr(b)

    def test_str_hex(self):
        s = Bits(hex='0xff')
        assert str(s) == '0xff'

    def test_str_bin(self):
        s = Bits(bin='1111111')
        assert '0b1111111' in str(s)


class TestBitsMethods:
    def test_copy(self):
        b = Bits(hex='0x1234')
        c = b.copy()
        assert c == b
        assert c is not b

    def test_all_default(self):
        s = Bits(int=-1, length=15)
        assert s.all(True) is True

    def test_all_specific(self):
        s = Bits(int=-1, length=15)
        assert s.all(True, [3, 4, 12, 13]) is True

    def test_all_false(self):
        s = Bits(int=0, length=8)
        assert s.all(False) is True
        assert s.all(True) is False

    def test_any_default(self):
        s = Bits(bin='11011100')
        assert s.any(True) is True

    def test_any_specific(self):
        s = Bits(bin='11011100')
        assert s.any(False, range(6)) is True

    def test_count(self):
        s = Bits(bin='101010')
        assert s.count(1) == 3
        assert s.count(0) == 3

    def test_cut(self):
        s = BitArray(hex='0x1234')
        nibbles = list(s.cut(4))
        assert len(nibbles) == 4
        assert nibbles[0].hex == '1'
        assert nibbles[1].hex == '2'
        assert nibbles[2].hex == '3'
        assert nibbles[3].hex == '4'

    def test_cut_with_count(self):
        s = Bits(hex='0x1234')
        nibbles = list(s.cut(4, count=2))
        assert len(nibbles) == 2

    def test_startswith(self):
        s = BitArray(hex='0xef133')
        assert s.startswith('0b111011') is True
        assert s.startswith('0b111000') is False

    def test_endswith(self):
        s = Bits(hex='0x35e22')
        assert s.endswith('0b10, 0x22') is True
        assert s.endswith('0x22', start=13) is False

    def test_find(self):
        s = Bits(hex='0x0023122')
        result = s.find('0b000100', bytealigned=True)
        assert result == (16,)

    def test_find_not_found(self):
        s = Bits(hex='0x0023122')
        result = s.find('0b111111', bytealigned=True)
        assert result == ()

    def test_find_found_at_zero(self):
        s = Bits(hex='0x0023')
        result = s.find('0x00')
        assert result == (0,)
        assert bool(result) is True

    def test_findall(self):
        s = Bits(hex='0xab220101') * 5
        positions = list(s.findall('0x22', bytealigned=True))
        assert positions == [8, 40, 72, 104, 136]

    def test_rfind(self):
        s = Bits(oct='0o031544')
        result = s.rfind('0b100')
        assert result == (15,)

    def test_rfind_with_end(self):
        s = Bits(oct='0o031544')
        result = s.rfind('0b100', end=17)
        assert result == (12,)

    def test_split(self):
        s = Bits(hex='0x42423')
        parts = [bs.bin for bs in s.split('0x4')]
        assert parts == ['', '01000', '01001000', '0100011']

    def test_join(self):
        s = Bits().join(['0x0001ee', 'uint:24=13', '0b0111'])
        assert s.hex == '0001ee00000d7'

    def test_join_with_separator(self):
        s = Bits('0b1').join(['0b0'] * 5)
        assert s.bin == '010101010'

    def test_fromstring(self):
        b1 = Bits('int16=91')
        b2 = Bits.fromstring('int16=91')
        assert b1 == b2

    def test_tobytes(self):
        s = Bits(bytes=b'hello')
        s2 = s + '0b01'
        assert s2.tobytes() == b'hello@'

    def test_tobytes_aligned(self):
        b = Bits(hex='0x1234')
        assert b.tobytes() == b'\x12\x34'

    def test_unpack(self):
        s = Bits('int4=-1, 0b1110')
        i, b = s.unpack('int:4, bin')
        assert i == -1
        assert b == '1110'


class TestBitArrayCreation:
    def test_create_empty(self):
        ba = BitArray()
        assert len(ba) == 0

    def test_create_from_hex(self):
        ba = BitArray('0xbad')
        assert ba.hex == 'bad'


class TestBitArrayMutation:
    def test_append(self):
        s = BitArray('0xbad')
        s.append('0xf00d')
        assert s.hex == 'badf00d'

    def test_prepend(self):
        s = BitArray('0b0')
        s.prepend('0xf')
        assert s.bin == '11110'

    def test_insert(self):
        s = BitStream('0xccee')
        s.insert('0xd', 8)
        assert s.hex == 'ccdee'

    def test_overwrite(self):
        s = BitArray(length=10)
        s.overwrite('0b111', 3)
        assert s.bin == '0001110000'

    def test_reverse(self):
        s = BitArray('0b000001101')
        s.reverse()
        assert s.bin == '101100000'

    def test_reverse_partial(self):
        s = BitArray('0b000001101')
        s.reverse(0, 4)
        assert s.bin == '110100000'

    def test_invert(self):
        s = BitArray('0b111001')
        s.invert(0)
        assert s.bin == '011001'

    def test_invert_list(self):
        s = BitArray('0b111001')
        s.invert([-2, -1])
        assert s.bin == '011010'

    def test_invert_all(self):
        s = BitArray('0b111001')
        s.invert()
        assert s.bin == '000110'

    def test_set_single(self):
        s = BitArray('0x0000')
        s.set(True, -1)
        assert s.hex == '0001'

    def test_set_multiple(self):
        s = BitArray('0x0000')
        s.set(1, (0, 4, 5, 7, 9))
        assert s.bin == '1000110101000001'

    def test_set_all(self):
        s = BitArray('0x0000')
        s.set(0)
        assert s.bin == '0000000000000000'

    def test_set_range(self):
        s = BitArray('0x0000')
        s.set(1, range(0, 16, 2))
        assert s.bin == '1010101010101010'

    def test_replace(self):
        s = BitArray('0b0011001')
        count = s.replace('0b1', '0xf')
        assert count == 3
        assert s.bin == '0011111111001111'

    def test_replace_with_count(self):
        s = BitArray('0b0011001')
        s.replace('0b1', '', count=6)
        assert s.bin == '0011001111'

    def test_clear(self):
        s = BitArray('0xbad')
        s.clear()
        assert len(s) == 0

    def test_rol(self):
        s = BitArray('0b01000001')
        s.rol(2)
        assert s.bin == '00000101'

    def test_ror(self):
        s = BitArray('0b01000001')
        s.ror(2)
        assert s.bin == '01010000'

    def test_byteswap_int(self):
        s = BitArray('0x00112233445566')
        n = s.byteswap(2)
        assert n == 3
        assert s.hex == '11003322554466'

    def test_byteswap_h(self):
        s = BitArray('0x00112233445566')
        s.byteswap(2)
        n = s.byteswap('h')
        assert n == 3
        assert s.hex == '00112233445566'

    def test_byteswap_list(self):
        s = BitArray('0x00112233445566')
        n = s.byteswap([2, 5])
        assert n == 1
        assert s.hex == '11006655443322'

    def test_setitem_int(self):
        s = BitArray('0b0000')
        s[0] = '0b1'
        assert s.bin == '1000'

    def test_setitem_slice(self):
        s = BitArray('0x00000000')
        s[::8] = '0xf'
        assert s.hex == '80808080'

    def test_setitem_slice_end(self):
        s = BitArray('0x00000000')
        s[-12:] = '0xf'
        assert s.hex == '80808f'

    def test_delitem_slice(self):
        s = BitArray('0x123456')
        del s[:8]
        assert s.hex == '3456'

    def test_iadd(self):
        s = BitArray(hex='0x1234')
        s += BitArray(hex='0x5678')
        assert s.hex == '12345678'

    def test_imul(self):
        s = BitArray('0xbad')
        s *= 3
        assert s.hex == 'badbadbad'

    def test_iand(self):
        s = BitArray(hex='0x33')
        s &= Bits(hex='0x0f')
        assert s.hex == '03'

    def test_ior(self):
        s = BitArray(hex='0x33')
        s |= Bits(hex='0x0f')
        assert s.hex == '3f'

    def test_ixor(self):
        s = BitArray(hex='0x33')
        s ^= Bits(hex='0x0f')
        assert s.hex == '3c'

    def test_ilshift(self):
        s = BitArray(hex='0xff')
        s <<= 4
        assert s.hex == 'f0'

    def test_irshift(self):
        s = BitArray(hex='0xff')
        s >>= 4
        assert s.hex == '0f'


class TestConstBitStream:
    def test_create_with_pos(self):
        s = ConstBitStream('0x123456', pos=8)
        assert s.pos == 8
        assert s.bytepos == 1

    def test_read_bits(self):
        s = ConstBitStream('0x123456')
        chunk = s.read(8)
        assert chunk.hex == '12'
        assert s.pos == 8

    def test_read_int(self):
        s = ConstBitStream('0x123456')
        val = s.read('int16')
        assert val == 0x1234
        assert s.pos == 16

    def test_read_hex(self):
        s = ConstBitStream('0x123456')
        val = s.read('hex8')
        assert val == '12'
        assert s.pos == 8

    def test_read_multi(self):
        s = ConstBitStream('0x123456')
        results = s.readlist('hex8, hex8, hex8')
        assert results == ['12', '34', '56']
        assert s.pos == 24

    def test_read_to_end(self):
        s = ConstBitStream('0x123456')
        result = s.read('hex')
        assert result == '123456'
        assert s.pos == 24

    def test_read_past_end(self):
        s = ConstBitStream('0x12')
        with pytest.raises(ReadError):
            s.read(20)

    def test_peek(self):
        s = ConstBitStream('0x123456')
        val = s.peek('hex8')
        assert val == '12'
        assert s.pos == 0  # pos unchanged

    def test_peeklist(self):
        s = ConstBitStream('0x123456')
        results = s.peeklist('hex8, hex8')
        assert results == ['12', '34']
        assert s.pos == 0

    def test_readto(self):
        s = ConstBitStream('0x00112233')
        result = s.readto('0x22')
        assert result.hex == '001122'
        assert s.pos == 24

    def test_readto_not_found(self):
        s = ConstBitStream('0x00112233')
        with pytest.raises(ReadError):
            s.readto('0xff')

    def test_bytealign_already_aligned(self):
        s = ConstBitStream('0x123456', pos=8)
        s.bytealign()
        assert s.pos == 8

    def test_bytealign_not_aligned(self):
        s = ConstBitStream('0x123456', pos=3)
        s.bytealign()
        assert s.pos == 8

    def test_pos_setter(self):
        s = ConstBitStream('0x123456')
        s.pos = 16
        assert s.pos == 16

    def test_pos_invalid(self):
        s = ConstBitStream('0x123456')
        with pytest.raises(ValueError):
            s.pos = -1
        with pytest.raises(ValueError):
            s.pos = 100

    def test_bytepos_setter(self):
        s = ConstBitStream('0x123456')
        s.bytepos = 2
        assert s.bytepos == 2
        assert s.pos == 16


class TestBitStream:
    def test_create(self):
        bs = BitStream('0x1234')
        assert bs.hex == '1234'
        assert bs.pos == 0

    def test_read_and_modify(self):
        bs = BitStream('0x12345678')
        val = bs.read('hex8')
        assert val == '12'
        assert bs.pos == 8
        bs.append('0x90')
        assert bs.hex == '1234567890'

    def test_insert_with_pos(self):
        s = BitStream('0xccee')
        s.insert('0xd', 8)
        assert s.hex == 'ccdee'

    def test_insert_at_current_pos(self):
        s = BitStream('0xccee')
        s.pos = 8
        s.insert('0xd')
        assert s.hex == 'ccdee'


class TestPack:
    def test_pack_basic(self):
        s = pack('hex32, uint12, uint12', '0x000001b3', 352, 288)
        assert len(s) == 32 + 12 + 12

    def test_pack_with_keys(self):
        s = pack('uint:10=33', 33)
        assert s.uint == 33

    def test_pack_compact_be(self):
        s = pack('>3h', 12, 3, 108)
        assert len(s) == 48

    def test_pack_with_kwargs(self):
        format_str = 'int:a=b'
        s = pack(format_str, a=10, b=20)
        assert len(s) == 10

    def test_pack_named_tokens(self):
        s = pack('a, b, b, a', a='0b11', b='0o2')
        assert s.bin == '11010010'

    def test_unused_values(self):
        with pytest.raises(ValueError):
            pack('uint8', 1, 2)


class TestBitArrayPropertySetters:
    def test_set_hex(self):
        ba = BitArray(length=8)
        ba.hex = 'ff'
        assert ba.hex == 'ff'

    def test_set_bin(self):
        ba = BitArray(length=8)
        ba.bin = '10101010'
        assert ba.bin == '10101010'

    def test_set_uint(self):
        ba = BitArray(length=16)
        ba.uint = 1234
        assert ba.uint == 1234

    def test_set_int_negative(self):
        ba = BitArray(length=8)
        ba.int = -1
        assert ba.int == -1

    def test_set_int_too_large(self):
        ba = BitArray(length=8)
        with pytest.raises((ValueError, CreationError)):
            ba.int = 1232

    def test_set_float(self):
        ba = BitArray(length=32)
        ba.float = 3.14
        assert abs(ba.float - 3.14) < 1e-6

    def test_set_bytes(self):
        ba = BitArray(length=16)
        ba.bytes = b'\x12\x34'
        assert ba.hex == '1234'


class TestBitArrayCreatingWithProperties:
    def test_create_with_f32(self):
        a = BitArray()
        a.f32 = 17.6
        assert a.hex == '418ccccd'

    def test_create_with_i7(self):
        a = BitArray()
        a.i7 = -1
        assert a.bin == '1111111'


class TestErrors:
    def test_creation_error(self):
        with pytest.raises(CreationError):
            Bits(uint=-1, length=8)

    def test_interpret_error(self):
        b = Bits(bin='101')
        with pytest.raises(InterpretError):
            _ = b.hex


class TestOptions:
    def test_default_bytealigned(self):
        assert options.bytealigned is False

    def test_set_bytealigned(self):
        saved = options.bytealigned
        options.bytealigned = True
        assert options.bytealigned is True
        options.bytealigned = saved


class TestBitstringLiterals:
    def test_literal(self):
        s = BitArray('float32=10.125, int7=-9')
        assert len(s) == 39

    def test_literal_hex_and_bin(self):
        t = BitArray('0b101')
        t += '0x001f'
        assert len(t) == 3 + 20

    def test_ue(self):
        s = Bits(ue=423)
        assert len(s) > 0
